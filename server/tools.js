/**
 * The receptionist's tools. Gemini decides when to call them; the server runs them
 * against the real calendar and sends the results back. Nothing the caller says can
 * book a slot that is not actually free.
 */

import crypto from 'node:crypto';
import { HOURS_TEXT, SERVICES, teamMember } from './clinic.js';
import { BOOKING_WINDOW_DAYS, freeTimes, lastBookableDate, opening, slotKeys, spread } from './slots.js';
import { addDays, clinicNow, isDate, isTime, spokenDate, spokenTime } from './time.js';

const SERVICE_IDS = Object.keys(SERVICES);

/** Function declarations sent to Gemini in the session setup. */
export function toolDeclarations({ blocking = true } = {}) {
	const extra = blocking ? { behavior: 'BLOCKING' } : {};
	return [
		{
			name: 'check_availability',
			description: 'Find free appointment times on a given date. Always call this before offering or confirming any time.',
			parameters: {
				type: 'OBJECT',
				properties: {
					date: { type: 'STRING', description: 'Date in YYYY-MM-DD format, clinic local time.' },
					service: { type: 'STRING', enum: SERVICE_IDS, description: 'The service the caller needs.' },
				},
				required: ['date', 'service'],
			},
			...extra,
		},
		{
			name: 'book_appointment',
			description: 'Book an appointment after the caller has confirmed the date, time, service, their name and phone number.',
			parameters: {
				type: 'OBJECT',
				properties: {
					patient_name: { type: 'STRING', description: "The caller's full name." },
					phone: { type: 'STRING', description: 'Contact phone number, digits only if possible.' },
					date: { type: 'STRING', description: 'YYYY-MM-DD' },
					time: { type: 'STRING', description: 'HH:MM in 24-hour clinic local time, exactly as returned by check_availability.' },
					service: { type: 'STRING', enum: SERVICE_IDS },
					new_patient: { type: 'BOOLEAN', description: 'True if they have not visited the clinic before.' },
					notes: { type: 'STRING', description: 'Anything the dentist should know, e.g. nervous patient, tooth pain. Optional.' },
				},
				required: ['patient_name', 'phone', 'date', 'time', 'service'],
			},
			...extra,
		},
		{
			name: 'cancel_appointment',
			description: 'Cancel an upcoming appointment after the caller has confirmed they want to cancel it.',
			parameters: {
				type: 'OBJECT',
				properties: {
					phone: { type: 'STRING', description: 'Phone number the appointment was booked with.' },
					reference: { type: 'STRING', description: 'Booking reference such as MR-4821, if the caller has it.' },
					date: { type: 'STRING', description: 'YYYY-MM-DD of the appointment, if the caller has more than one.' },
				},
				required: ['phone'],
			},
			...extra,
		},
		{
			name: 'take_message',
			description: 'Leave a message for the clinic team to call the caller back (insurance questions, billing, anything you cannot answer).',
			parameters: {
				type: 'OBJECT',
				properties: {
					name: { type: 'STRING' },
					phone: { type: 'STRING' },
					message: { type: 'STRING', description: 'What the caller needs, in one or two sentences.' },
					urgent: { type: 'BOOLEAN' },
				},
				required: ['name', 'phone', 'message'],
			},
			...extra,
		},
		{
			name: 'end_call',
			description: 'Hang up after you have said goodbye and the caller has nothing else to ask.',
			parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING' } } },
			...extra,
		},
	];
}

const digits = (value) => String(value ?? '').replace(/\D/g, '');
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function takenKeys(store, date) {
	const rows = await store.appointments.find({ date, status: 'booked' });
	return new Set(rows.flatMap((r) => r.slotKeys || []));
}

function checkDate(date, now) {
	const today = clinicNow(now).date;
	if (!isDate(date)) return 'The date must be in YYYY-MM-DD format.';
	if (date < today) return `That date is in the past. Today is ${spokenDate(today)}.`;
	if (date > lastBookableDate(now)) return `We only book up to ${BOOKING_WINDOW_DAYS} days ahead.`;
	return null;
}

async function nextOpenDays(store, from, minutes, now, count = 3) {
	const out = [];
	for (let i = 1; i <= 21 && out.length < count; i += 1) {
		const date = addDays(from, i);
		if (date > lastBookableDate(now)) break;
		const times = freeTimes(date, minutes, await takenKeys(store, date), now);
		if (times.length) out.push({ date, day: spokenDate(date), first_times: spread(times, 3) });
	}
	return out;
}

async function newReference(store) {
	for (let i = 0; i < 20; i += 1) {
		const reference = `MR-${crypto.randomInt(1000, 10000)}`;
		if (!(await store.appointments.findOne({ reference }))) return reference;
	}
	return `MR-${crypto.randomInt(10000, 100000)}`;
}

export const handlers = {
	async check_availability({ date, service }, { store, now }) {
		const svc = SERVICES[service];
		if (!svc) return { error: `Unknown service. Use one of: ${SERVICE_IDS.join(', ')}.` };
		const problem = checkDate(date, now);
		if (problem) return { error: problem };
		const day = spokenDate(date);
		if (!opening(date)) {
			return { date, day, open: false, note: `Closed that day. Opening hours: ${HOURS_TEXT}.`, next_available: await nextOpenDays(store, date, svc.minutes, now) };
		}
		const times = freeTimes(date, svc.minutes, await takenKeys(store, date), now);
		if (!times.length) {
			return { date, day, open: true, free_times: [], note: 'Fully booked that day.', next_available: await nextOpenDays(store, date, svc.minutes, now) };
		}
		const offer = spread(times, 6);
		return {
			date,
			day,
			service: svc.label,
			minutes: svc.minutes,
			with: teamMember(svc.with).name,
			free_times: offer.map((t) => ({ time: t, spoken: spokenTime(t) })),
			more_available: times.length > offer.length ? times.length - offer.length : 0,
		};
	},

	async book_appointment(args, { store, now, call }) {
		const svc = SERVICES[args.service];
		if (!svc) return { booked: false, error: 'Unknown service.' };
		const name = clean(args.patient_name, 60);
		if (name.length < 2) return { booked: false, error: "Ask for the caller's name." };
		const phoneDigits = digits(args.phone);
		if (phoneDigits.length < 7 || phoneDigits.length > 15) return { booked: false, error: 'The phone number looks incomplete. Ask for it again.' };
		const problem = checkDate(args.date, now);
		if (problem) return { booked: false, error: problem };
		if (!isTime(args.time)) return { booked: false, error: 'Time must be HH:MM from check_availability.' };
		const free = freeTimes(args.date, svc.minutes, await takenKeys(store, args.date), now);
		if (!free.includes(args.time)) {
			return { booked: false, error: 'That time is no longer free.', free_times: spread(free, 4).map((t) => ({ time: t, spoken: spokenTime(t) })) };
		}
		const reference = await newReference(store);
		const [y, m, d] = args.date.split('-').map(Number);
		try {
			await store.appointments.create({
				reference,
				patientName: name,
				phone: clean(args.phone, 30),
				phoneDigits,
				service: args.service,
				serviceLabel: svc.label,
				withId: svc.with,
				date: args.date,
				time: args.time,
				minutes: svc.minutes,
				slotKeys: slotKeys(args.date, args.time, svc.minutes),
				newPatient: Boolean(args.new_patient),
				notes: clean(args.notes, 300),
				status: 'booked',
				source: 'ai-call',
				demo: false,
				expiresAt: new Date(Date.UTC(y, m - 1, d + 7)),
			});
		} catch (error) {
			if (error.code === 11000) return { booked: false, error: 'Someone just booked that time. Offer another one.' };
			throw error;
		}
		call?.booked.push(reference);
		return {
			booked: true,
			reference,
			reference_spoken: reference.replace('MR-', 'M R ').split('').join(' ').replace(/\s+/g, ' '),
			day: spokenDate(args.date),
			time: spokenTime(args.time),
			service: svc.label,
			with: teamMember(svc.with).name,
			price_guide: svc.price,
			remind: args.new_patient ? 'Bring photo ID, insurance card and a list of medication. Arrive 10 minutes early.' : 'Please give 24 hours notice to cancel.',
		};
	},

	async cancel_appointment(args, { store, now }) {
		const phoneDigits = digits(args.phone);
		if (phoneDigits.length < 7) return { cancelled: false, error: 'Ask for the phone number used to book.' };
		const today = clinicNow(now).date;
		let rows = await store.appointments.find({ status: 'booked', demo: false, date: { $gte: today } }, { sort: { date: 1, time: 1 } });
		rows = rows.filter((r) => r.phoneDigits.slice(-7) === phoneDigits.slice(-7));
		if (args.reference) {
			const ref = String(args.reference).toUpperCase().replace(/[^A-Z0-9]/g, '');
			rows = rows.filter((r) => r.reference.replace('-', '') === ref || r.reference.replace('MR-', '') === ref);
		}
		if (args.date) rows = rows.filter((r) => r.date === args.date);
		if (!rows.length) return { cancelled: false, error: 'No upcoming appointment found for that phone number. Check the number or offer to take a message.' };
		if (rows.length > 1) {
			return { cancelled: false, error: 'More than one upcoming appointment. Ask which one.', appointments: rows.map((r) => ({ date: r.date, day: spokenDate(r.date), time: spokenTime(r.time), service: r.serviceLabel, reference: r.reference })) };
		}
		const appt = rows[0];
		await store.appointments.update(appt.id, { status: 'cancelled', slotKeys: [] });
		return { cancelled: true, day: spokenDate(appt.date), time: spokenTime(appt.time), service: appt.serviceLabel, reference: appt.reference };
	},

	async take_message(args, { store, now }) {
		const name = clean(args.name, 60);
		const phoneDigits = digits(args.phone);
		const message = clean(args.message, 500);
		if (!name || phoneDigits.length < 7 || !message) return { saved: false, error: 'Need a name, phone number and the message.' };
		await store.messages.create({ name, phone: clean(args.phone, 30), message, urgent: Boolean(args.urgent), status: 'new', expiresAt: new Date(now.getTime() + 7 * 86_400_000) });
		return { saved: true, callback: 'The team will call back during opening hours, usually the same working day.' };
	},

	async end_call(args, { call }) {
		if (call) call.ending = true;
		return { ok: true };
	},
};

/** Run one tool call safely; errors become a short message the model can relay. */
export async function runTool(name, args, ctx) {
	const handler = handlers[name];
	if (!handler) return { error: `Unknown tool ${name}.` };
	try {
		return await handler(args || {}, ctx);
	} catch (error) {
		console.error(`[tool] ${name} failed:`, error);
		return { error: 'The booking system had a problem. Apologise and offer to take a message instead.' };
	}
}
