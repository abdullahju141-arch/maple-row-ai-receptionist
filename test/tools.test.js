import assert from 'node:assert/strict';
import test from 'node:test';
import { freeTimes, slotKeys, spread, startTimes } from '../server/slots.js';
import { createMemoryStore } from '../server/store/memory.js';
import { ensureSampleBookings } from '../server/store/index.js';
import { runTool } from '../server/tools.js';
import { addDays, clinicNow, spokenDate, spokenTime } from '../server/time.js';
import { systemPrompt } from '../server/prompt.js';
import { buildSetup } from '../server/relay.js';

// Tuesday 24 November 2026, 08:00 in Springfield (UTC-6).
const NOW = new Date('2026-11-24T14:00:00Z');

test('clinic time zone and spoken formats', () => {
	assert.deepEqual(clinicNow(NOW), { date: '2026-11-24', time: '08:00', minutes: 480 });
	assert.equal(spokenDate('2026-11-24'), 'Tuesday 24 November');
	assert.equal(spokenTime('14:30'), '2:30pm');
	assert.equal(spokenTime('09:00'), '9am');
	assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('slots follow opening hours and service length', () => {
	assert.equal(startTimes('2026-11-24', 30).length, 18); // 9:00-18:00
	assert.equal(startTimes('2026-11-24', 60).at(-1), '17:00');
	assert.deepEqual(startTimes('2026-11-28', 60), ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00']); // Saturday
	assert.deepEqual(startTimes('2026-11-29', 30), []); // Sunday
	assert.deepEqual(slotKeys('2026-11-24', '09:30', 60), ['2026-11-24|09:30', '2026-11-24|10:00']);
	const taken = new Set(['2026-11-24|10:00']);
	const free = freeTimes('2026-11-24', 60, taken, NOW);
	assert.ok(!free.includes('09:30') && !free.includes('10:00') && free.includes('09:00') && free.includes('10:30'));
	// Same-day bookings need an hour's notice: at 08:00 the 09:00 slot is fine, at 08:30 it is not.
	assert.ok(!freeTimes('2026-11-24', 30, new Set(), new Date('2026-11-24T14:31:00Z')).includes('09:00'));
	assert.equal(spread(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], 4).length, 4);
});

test('availability, booking, double-booking protection and cancelling', async () => {
	const store = await createMemoryStore();
	const ctx = { store, now: NOW, call: { booked: [] } };

	const avail = await runTool('check_availability', { date: '2026-11-25', service: 'checkup-clean' }, ctx);
	assert.equal(avail.day, 'Wednesday 25 November');
	assert.ok(avail.free_times.length >= 3);
	assert.equal(avail.with, 'Sofia Marin');

	const time = avail.free_times[0].time;
	const booking = await runTool('book_appointment', { patient_name: 'Sara Khan', phone: '(217) 555-0101', date: '2026-11-25', time, service: 'checkup-clean', new_patient: true }, ctx);
	assert.equal(booking.booked, true);
	assert.match(booking.reference, /^MR-\d{4}$/);
	assert.deepEqual(ctx.call.booked, [booking.reference]);

	const again = await runTool('book_appointment', { patient_name: 'Other Person', phone: '2175550102', date: '2026-11-25', time, service: 'emergency' }, ctx);
	assert.equal(again.booked, false);
	assert.ok(again.free_times.length > 0);

	const after = await runTool('check_availability', { date: '2026-11-25', service: 'emergency' }, ctx);
	assert.ok(!after.free_times.some((t) => t.time === time));

	const wrongPhone = await runTool('cancel_appointment', { phone: '2175559999' }, ctx);
	assert.equal(wrongPhone.cancelled, false);
	const cancelled = await runTool('cancel_appointment', { phone: '217-555-0101', reference: booking.reference.toLowerCase() }, ctx);
	assert.equal(cancelled.cancelled, true);
	const rebook = await runTool('book_appointment', { patient_name: 'Other Person', phone: '2175550102', date: '2026-11-25', time, service: 'emergency' }, ctx);
	assert.equal(rebook.booked, true);
});

test('bad input is refused with a message the model can relay', async () => {
	const store = await createMemoryStore();
	const ctx = { store, now: NOW };
	assert.match((await runTool('check_availability', { date: '2026-11-20', service: 'filling' }, ctx)).error, /past/);
	assert.match((await runTool('check_availability', { date: '25/11/2026', service: 'filling' }, ctx)).error, /YYYY-MM-DD/);
	assert.match((await runTool('check_availability', { date: '2027-06-01', service: 'filling' }, ctx)).error, /60 days/);
	assert.match((await runTool('check_availability', { date: '2026-11-25', service: 'massage' }, ctx)).error, /Unknown service/);
	const sunday = await runTool('check_availability', { date: '2026-11-29', service: 'filling' }, ctx);
	assert.equal(sunday.open, false);
	assert.equal(sunday.next_available[0].date, '2026-11-30');
	assert.equal((await runTool('book_appointment', { patient_name: 'Al', phone: '123', date: '2026-11-25', time: '10:00', service: 'filling' }, ctx)).booked, false);
	assert.equal((await runTool('book_appointment', { patient_name: 'Al Smith', phone: '2175550000', date: '2026-11-25', time: '10:15', service: 'filling' }, ctx)).booked, false);
	assert.match((await runTool('nope', {}, ctx)).error, /Unknown tool/);
	assert.equal((await runTool('take_message', { name: 'Jo', phone: '2175550123', message: 'Question about my insurance plan' }, ctx)).saved, true);
	assert.equal(await store.messages.count(), 1);
});

test('fully booked days point to the next free days', async () => {
	const store = await createMemoryStore();
	const ctx = { store, now: NOW };
	for (const time of startTimes('2026-11-25', 30)) {
		await runTool('book_appointment', { patient_name: 'Filler Person', phone: '2175550000', date: '2026-11-25', time, service: 'emergency' }, ctx);
	}
	const full = await runTool('check_availability', { date: '2026-11-25', service: 'filling' }, ctx);
	assert.equal(full.free_times.length, 0);
	assert.equal(full.next_available[0].date, '2026-11-26');
});

test('sample bookings fill part of the calendar without overlaps', async () => {
	const store = await createMemoryStore();
	const added = await ensureSampleBookings(store, NOW, 7);
	assert.ok(added > 10);
	assert.equal(await ensureSampleBookings(store, NOW, 7), 0); // idempotent
	const rows = await store.appointments.find({ status: 'booked' });
	const keys = rows.flatMap((r) => r.slotKeys);
	assert.equal(new Set(keys).size, keys.length);
	assert.equal(await store.appointments.count({ date: '2026-11-29' }), 0); // closed Sunday
});

test('system prompt and setup message', () => {
	const prompt = systemPrompt(NOW);
	assert.match(prompt, /2026-11-25 = Wednesday 25 November \(tomorrow\)/);
	assert.match(prompt, /call 911/);
	assert.match(prompt, /AI assistant/);
	const setup = buildSetup({ liveModel: 'gemini-3.8-live', voice: 'Kore' }, NOW).setup;
	assert.equal(setup.model, 'models/gemini-3.8-live');
	assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
	assert.equal(setup.tools[0].functionDeclarations[0].behavior, 'BLOCKING');
	const old = buildSetup({ liveModel: 'gemini-3.1-flash-live-preview', voice: 'Kore' }, NOW).setup;
	assert.equal(old.tools[0].functionDeclarations[0].behavior, undefined);
});
