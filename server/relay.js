/**
 * Call relay: browser <-> this server <-> Gemini Live.
 *
 * Browser -> server: binary frames of 16 kHz 16-bit mono PCM (microphone), or JSON {type:'hangup'}.
 * Server -> browser: binary frames of 24 kHz 16-bit mono PCM (Ava's voice) and JSON events:
 *   status, transcript, interrupted, turn_complete, tool, end, error, time_left.
 *
 * The API key and the booking tools stay on the server, so the browser can never see the key
 * or book anything the calendar does not allow. The same relay can later be fed by a phone line.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { systemPrompt } from './prompt.js';
import { runTool, toolDeclarations } from './tools.js';
import { rateLimiter } from './http.js';

const SAFE_TOOL_FIELDS = ['day', 'time', 'service', 'reference', 'booked', 'cancelled', 'saved', 'open', 'error', 'with'];

export function buildSetup(config, now = new Date()) {
	const model = config.liveModel;
	// Gemini 3.8 Live calls tools asynchronously by default; the receptionist must wait for
	// the calendar's answer, so tools are declared BLOCKING. Older live models do not accept the field.
	const blocking = !/(^|-)(2\.5|3\.1)-/.test(model);
	return {
		setup: {
			model: model.startsWith('models/') ? model : `models/${model}`,
			generationConfig: {
				responseModalities: ['AUDIO'],
				speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } },
			},
			systemInstruction: { parts: [{ text: systemPrompt(now) }] },
			tools: [{ functionDeclarations: toolDeclarations({ blocking }) }],
			realtimeInputConfig: {
				automaticActivityDetection: { prefixPaddingMs: 200, silenceDurationMs: 700 },
			},
			inputAudioTranscription: {},
			outputAudioTranscription: {},
		},
	};
}

function clientIp(req) {
	const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
	return forwarded || req.socket.remoteAddress || 'unknown';
}

function sameOrigin(req) {
	const origin = req.headers.origin;
	if (!origin) return true; // non-browser clients (tests, future phone bridge)
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

function summarize(result) {
	const out = {};
	for (const key of SAFE_TOOL_FIELDS) if (result && result[key] !== undefined) out[key] = result[key];
	if (Array.isArray(result?.free_times)) out.free = result.free_times.map((t) => t.spoken);
	return out;
}

/**
 * Attach the call relay to an HTTP server at /api/call.
 *
 * @param {import('node:http').Server} server
 * @param {{config: object, store: object, now?: () => Date, WebSocketImpl?: typeof WebSocket}} deps
 */
export function attachRelay(server, { config, store, now = () => new Date(), WebSocketImpl = WebSocket }) {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
	const perIp = rateLimiter(config.callsPerIpPerHour, 60 * 60 * 1000);
	let day = '';
	let callsToday = 0;
	let active = 0;

	server.on('upgrade', (req, socket, head) => {
		const { pathname } = new URL(req.url, 'http://localhost');
		if (pathname !== '/api/call') {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			const reject = (code, message) => {
				ws.send(JSON.stringify({ type: 'error', code, message }));
				ws.close(4000, code);
			};
			if (!sameOrigin(req)) return reject('origin', 'Calls are only allowed from this website.');
			if (!config.geminiApiKey) return reject('offline', 'The AI receptionist is offline right now (no API key set).');
			const today = new Date().toISOString().slice(0, 10);
			if (today !== day) {
				day = today;
				callsToday = 0;
			}
			if (callsToday >= config.dailyCallLimit) return reject('daily_limit', 'The demo has reached its call limit for today. Please try again tomorrow.');
			if (active >= 10) return reject('busy', 'All lines are busy. Please try again in a minute.');
			if (!perIp(clientIp(req))) return reject('rate_limit', 'You have made several calls in the last hour. Please try again a bit later.');
			callsToday += 1;
			active += 1;
			ws.once('close', () => {
				active -= 1;
			});
			handleCall(ws, { config, store, now, WebSocketImpl });
		});
	});
	return wss;
}

function handleCall(browser, { config, store, now, WebSocketImpl }) {
	const call = { startedAt: now(), toolsUsed: [], booked: [], ending: false, ended: false };
	const sendBrowser = (data) => {
		if (browser.readyState === WebSocket.OPEN) browser.send(typeof data === 'string' ? data : data, { binary: typeof data !== 'string' });
	};
	const event = (payload) => sendBrowser(JSON.stringify(payload));
	let ready = false;
	let toolChain = Promise.resolve();

	event({ type: 'status', state: 'connecting', maxSeconds: config.maxCallSeconds });

	const upstream = new WebSocketImpl(`${config.liveUrl}?key=${encodeURIComponent(config.geminiApiKey)}`);
	const sendUp = (payload) => {
		if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(payload));
	};

	const finish = async (reason, message) => {
		if (call.ended) return;
		call.ended = true;
		clearTimeout(warnTimer);
		clearTimeout(limitTimer);
		if (message) event({ type: 'error', code: reason, message });
		event({ type: 'end', reason });
		if (browser.readyState === WebSocket.OPEN) browser.close(1000, reason);
		if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
		const endedAt = now();
		try {
			await store.calls.create({
				startedAt: call.startedAt,
				endedAt,
				seconds: Math.round((endedAt - call.startedAt) / 1000),
				endReason: reason,
				toolsUsed: call.toolsUsed,
				booked: call.booked,
				expiresAt: new Date(endedAt.getTime() + 30 * 86_400_000),
			});
		} catch (error) {
			console.error('[call] could not save call log:', error.message);
		}
	};

	const warnTimer = setTimeout(() => event({ type: 'time_left', seconds: 30 }), Math.max(0, config.maxCallSeconds - 30) * 1000);
	const limitTimer = setTimeout(() => finish('time_limit'), config.maxCallSeconds * 1000);

	upstream.on('open', () => sendUp(buildSetup(config, now())));

	upstream.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.setupComplete) {
			ready = true;
			event({ type: 'status', state: 'ready' });
			// Ask the model to answer the phone.
			sendUp({ realtimeInput: { text: '[The caller has just been connected. Answer the phone with your greeting.]' } });
		}

		const content = msg.serverContent;
		if (content) {
			for (const part of content.modelTurn?.parts || []) {
				if (part.inlineData?.data) sendBrowser(Buffer.from(part.inlineData.data, 'base64'));
			}
			if (content.inputTranscription?.text) event({ type: 'transcript', role: 'caller', text: content.inputTranscription.text });
			if (content.outputTranscription?.text) event({ type: 'transcript', role: 'ava', text: content.outputTranscription.text });
			if (content.interrupted) event({ type: 'interrupted' });
			if (content.turnComplete) {
				event({ type: 'turn_complete' });
				if (call.ending) toolChain.then(() => setTimeout(() => finish('ended_by_ava'), 300));
			}
		}

		if (msg.toolCall?.functionCalls?.length) {
			const calls = msg.toolCall.functionCalls;
			toolChain = toolChain.then(async () => {
				const functionResponses = [];
				for (const fc of calls) {
					event({ type: 'tool', phase: 'start', name: fc.name, args: { date: fc.args?.date, time: fc.args?.time, service: fc.args?.service } });
					const result = await runTool(fc.name, fc.args, { store, now: now(), call });
					call.toolsUsed.push(fc.name);
					event({ type: 'tool', phase: 'done', name: fc.name, result: summarize(result) });
					functionResponses.push({ id: fc.id, name: fc.name, response: result });
				}
				sendUp({ toolResponse: { functionResponses } });
			});
		}

		if (msg.goAway) event({ type: 'time_left', seconds: 10 });
	});

	upstream.on('close', (code, reason) => {
		const text = reason?.toString() || '';
		if (!call.ended) {
			console.error(`[call] Gemini closed the session (${code}) ${text}`);
			const message = ready
				? 'The call dropped. Please call again.'
				: /quota|exhausted|429/i.test(text)
					? 'The AI is busy right now (free quota reached). Please try again later.'
					: 'Could not connect to the AI receptionist. Please try again in a moment.';
			finish(ready ? 'dropped' : 'connect_failed', message);
		}
	});
	upstream.on('error', (error) => console.error('[call] upstream error:', error.message));

	browser.on('message', (data, isBinary) => {
		if (isBinary) {
			if (!ready || call.ended) return;
			sendUp({ realtimeInput: { audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
			return;
		}
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (msg.type === 'hangup') finish('caller_hung_up');
	});
	browser.on('close', () => finish('caller_hung_up'));
	browser.on('error', () => finish('caller_hung_up'));
}
