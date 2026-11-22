/**
 * A tiny stand-in for the Gemini Live WebSocket API, used by tests and the local demo script.
 * It follows a fixed "script": greet, check availability, book the first free time, hang up.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

const SILENCE = Buffer.alloc(4800).toString('base64'); // 100 ms of 24 kHz 16-bit silence

function tone(ms = 400, freq = 440) {
	const samples = Math.round(24 * ms);
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 24000) * 6000), i * 2);
	return buf.toString('base64');
}

export async function startMockGemini({ audioChunksBeforeRequest = 5, date } = {}) {
	const log = { setups: [], toolResponses: [], audioChunks: 0, texts: [], keys: [] };
	const server = http.createServer();
	const wss = new WebSocketServer({ server });

	wss.on('connection', (ws, req) => {
		log.keys.push(new URL(req.url, 'http://x').searchParams.get('key'));
		let step = 0;
		const send = (m) => ws.send(JSON.stringify(m));
		const say = (text, freq) => {
			send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tone(400, freq) } }] } } });
			send({ serverContent: { outputTranscription: { text } } });
			send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: SILENCE } }] } } });
			send({ serverContent: { generationComplete: true } });
			send({ serverContent: { turnComplete: true } });
		};

		ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.setup) {
				log.setups.push(msg.setup);
				send({ setupComplete: {} });
				return;
			}
			if (msg.realtimeInput?.text) {
				log.texts.push(msg.realtimeInput.text);
				say('Thank you for calling Maple Row Dental, this is Ava. How can I help you today?', 520);
				return;
			}
			if (msg.realtimeInput?.audio) {
				log.audioChunks += 1;
				if (log.audioChunks === audioChunksBeforeRequest && step === 0) {
					step = 1;
					send({ serverContent: { inputTranscription: { text: 'I need a check-up and clean.' } } });
					send({ toolCall: { functionCalls: [{ id: 'call-1', name: 'check_availability', args: { date, service: 'checkup-clean' } }] } });
				}
				return;
			}
			if (msg.toolResponse) {
				log.toolResponses.push(msg.toolResponse);
				const fr = msg.toolResponse.functionResponses[0];
				if (fr.name === 'check_availability') {
					const time = fr.response.free_times?.[0]?.time || '10:00';
					say(`I have ${fr.response.free_times?.[0]?.spoken || 'a time'} free.`, 600);
					send({
						toolCall: {
							functionCalls: [
								{ id: 'call-2', name: 'book_appointment', args: { patient_name: 'Test Caller', phone: '217 555 0199', date, time, service: 'checkup-clean', new_patient: true } },
							],
						},
					});
				} else if (fr.name === 'book_appointment') {
					say(`You're booked, reference ${fr.response.reference}.`, 660);
					send({ toolCall: { functionCalls: [{ id: 'call-3', name: 'end_call', args: { reason: 'done' } }] } });
				} else if (fr.name === 'end_call') {
					say('Goodbye!', 500);
				}
			}
		});
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return {
		url: `ws://127.0.0.1:${port}/live`,
		log,
		close: () =>
			new Promise((resolve) => {
				for (const c of wss.clients) c.terminate();
				wss.close();
				server.close(resolve);
			}),
	};
}
