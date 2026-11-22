import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { attachRelay } from '../server/relay.js';
import { createMemoryStore } from '../server/store/memory.js';
import { addDays, clinicNow } from '../server/time.js';
import { startMockGemini } from './mock-gemini.js';

function nextWeekday(from) {
	let d = addDays(from, 1);
	while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, 1);
	return d;
}

async function startServer(overrides = {}) {
	const store = await createMemoryStore();
	const config = {
		root: new URL('..', import.meta.url).pathname,
		geminiApiKey: 'test-key',
		liveModel: 'gemini-3.8-live',
		voice: 'Kore',
		liveUrl: 'ws://127.0.0.1:1/unused',
		adminPassword: 'secret-pass',
		jwtSecret: 'x'.repeat(32),
		maxCallSeconds: 60,
		callsPerIpPerHour: 6,
		dailyCallLimit: 100,
		...overrides,
	};
	const server = http.createServer(createApp({ config, store }));
	attachRelay(server, { config, store });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `127.0.0.1:${server.address().port}`;
	return { store, config, server, base, close: () => new Promise((r) => server.close(r)) };
}

function runCall(base, { origin, frames = 8 } = {}) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://${base}/api/call`, origin ? { headers: { origin } } : undefined);
		const events = [];
		let audioBytes = 0;
		ws.on('message', (data, isBinary) => {
			if (isBinary) {
				audioBytes += data.length;
				return;
			}
			const msg = JSON.parse(data.toString());
			events.push(msg);
			if (msg.type === 'status' && msg.state === 'ready') {
				for (let i = 0; i < frames; i += 1) ws.send(Buffer.alloc(1280)); // 40 ms of 16 kHz audio each
			}
		});
		ws.on('close', (code) => resolve({ events, audioBytes, code }));
	});
}

test('a full call: greeting, availability, booking, hang-up', async () => {
	const date = nextWeekday(clinicNow().date);
	const mock = await startMockGemini({ date });
	const app = await startServer({ liveUrl: mock.url });
	try {
		const { events, audioBytes } = await runCall(app.base);
		const types = events.map((e) => e.type);
		assert.deepEqual(events[0], { type: 'status', state: 'connecting', maxSeconds: 60 });
		assert.ok(types.includes('transcript'));
		assert.ok(audioBytes > 10_000, 'Ava audio reached the browser');
		assert.equal(events.at(-1).type, 'end');
		assert.equal(events.at(-1).reason, 'ended_by_ava');

		// Setup sent to Gemini: key, model, tools, transcription.
		assert.equal(mock.log.keys[0], 'test-key');
		const setup = mock.log.setups[0];
		assert.equal(setup.model, 'models/gemini-3.8-live');
		assert.deepEqual(setup.tools[0].functionDeclarations.map((f) => f.name), ['check_availability', 'book_appointment', 'cancel_appointment', 'take_message', 'end_call']);
		assert.ok(setup.inputAudioTranscription && setup.outputAudioTranscription);
		assert.ok(mock.log.audioChunks >= 5, 'microphone audio forwarded');

		// The booking really landed in the calendar.
		const booked = events.find((e) => e.type === 'tool' && e.phase === 'done' && e.name === 'book_appointment');
		assert.equal(booked.result.booked, true);
		const rows = await app.store.appointments.find({ demo: false });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].date, date);
		assert.equal(rows[0].patientName, 'Test Caller');
		assert.equal(rows[0].phoneDigits, '2175550199');

		// Public schedule shows it as booked, without personal details.
		const sched = await (await fetch(`http://${app.base}/api/schedule?date=${date}`)).json();
		const slot = sched.slots.find((s) => s.time === rows[0].time);
		assert.equal(slot.state, 'booked');
		assert.equal(slot.fromCall, true);
		assert.ok(!JSON.stringify(sched).includes('Test Caller'));

		// The call was logged.
		await new Promise((r) => setTimeout(r, 50));
		const calls = await app.store.calls.find({});
		assert.equal(calls[0].endReason, 'ended_by_ava');
		assert.deepEqual(calls[0].booked, [rows[0].reference]);
	} finally {
		await app.close();
		await mock.close();
	}
});

test('calls are refused without a key, from other sites, and over the hourly limit', async () => {
	const offline = await startServer({ geminiApiKey: '' });
	try {
		const { events } = await runCall(offline.base);
		assert.equal(events[0].code, 'offline');
	} finally {
		await offline.close();
	}

	const mock = await startMockGemini({ date: nextWeekday(clinicNow().date) });
	const app = await startServer({ liveUrl: mock.url, callsPerIpPerHour: 1 });
	try {
		const foreign = await runCall(app.base, { origin: 'https://evil.example' });
		assert.equal(foreign.events[0].code, 'origin');
		const first = await runCall(app.base, { origin: `http://${app.base}` });
		assert.equal(first.events.at(-1).type, 'end');
		const second = await runCall(app.base);
		assert.equal(second.events[0].code, 'rate_limit');
	} finally {
		await app.close();
		await mock.close();
	}
});

test('a failed connection to Gemini tells the caller', async () => {
	const app = await startServer({ liveUrl: 'ws://127.0.0.1:9/nothing-here' });
	try {
		const { events } = await runCall(app.base);
		const error = events.find((e) => e.type === 'error');
		assert.equal(error.code, 'connect_failed');
		assert.equal(events.at(-1).type, 'end');
	} finally {
		await app.close();
	}
});

test('admin login, data and actions', async () => {
	const app = await startServer();
	const url = `http://${app.base}`;
	try {
		assert.equal((await fetch(`${url}/api/admin/data`)).status, 401);
		const bad = await fetch(`${url}/api/admin/login`, { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
		assert.equal(bad.status, 401);
		const { token } = await (await fetch(`${url}/api/admin/login`, { method: 'POST', body: JSON.stringify({ password: 'secret-pass' }) })).json();
		const auth = { Authorization: `Bearer ${token}` };
		await app.store.messages.create({ name: 'Jo', phone: '2175550123', message: 'Call me', status: 'new' });
		const data = await (await fetch(`${url}/api/admin/data`, { headers: auth })).json();
		assert.equal(data.messages.length, 1);
		const id = data.messages[0].id;
		assert.equal((await fetch(`${url}/api/admin/messages/${id}/handled`, { method: 'POST', headers: auth })).status, 200);
		assert.equal((await fetch(`${url}/api/admin/messages/${id}`, { method: 'DELETE', headers: auth })).status, 200);
		assert.equal((await fetch(`${url}/api/admin/messages/${id}`, { method: 'DELETE', headers: auth })).status, 404);
		const health = await (await fetch(`${url}/api/health`)).json();
		assert.deepEqual(health, { ok: true, store: 'memory', ai: true, model: 'gemini-3.8-live' });
		assert.equal((await fetch(`${url}/nope.html`)).status, 404);
		assert.equal((await fetch(`${url}/../server/config.js`)).status, 404);
	} finally {
		await app.close();
	}
});
