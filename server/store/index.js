/**
 * Picks the store (MongoDB or in-memory) and keeps a few sample bookings on the
 * calendar so the schedule never looks empty. Sample bookings are marked demo:true
 * and show only as "Booked" on the public board.
 */

import { SERVICES } from '../clinic.js';
import { slotKeys, startTimes } from '../slots.js';
import { addDays, clinicNow } from '../time.js';
import { createMemoryStore } from './memory.js';

export async function createStore(config) {
	if (config.mongoUri) {
		const { createMongoStore } = await import('./mongo.js');
		return createMongoStore(config.mongoUri);
	}
	return createMemoryStore();
}

/** Small deterministic random generator so a given day always gets the same sample bookings. */
function seeded(text) {
	let h = 2166136261;
	for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	return () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return ((h ^= h >>> 16) >>> 0) / 4294967296;
	};
}

const SAMPLE_SERVICES = ['checkup-clean', 'checkup-clean', 'filling', 'new-patient-exam', 'child-checkup', 'emergency', 'implant'];

/** Make sure the next `days` days have some sample bookings (about a third of the day). */
export async function ensureSampleBookings(store, now = new Date(), days = 10) {
	const today = clinicNow(now).date;
	let added = 0;
	for (let i = 0; i < days; i += 1) {
		const date = addDays(today, i);
		const existing = await store.appointments.count({ date, demo: true });
		if (existing > 0) continue;
		const rand = seeded(date);
		const times = startTimes(date, 30);
		const target = Math.round(times.length * 0.3);
		for (let n = 0; n < target * 2 && n < 40; n += 1) {
			const serviceId = SAMPLE_SERVICES[Math.floor(rand() * SAMPLE_SERVICES.length)];
			const service = SERVICES[serviceId];
			const fits = startTimes(date, service.minutes);
			if (!fits.length) break;
			const time = fits[Math.floor(rand() * fits.length)];
			try {
				await store.appointments.create({
					reference: `DEMO-${date.replaceAll('-', '')}-${n}`,
					patientName: 'Sample patient',
					phone: '-',
					phoneDigits: '0',
					service: serviceId,
					serviceLabel: service.label,
					withId: service.with,
					date,
					time,
					minutes: service.minutes,
					slotKeys: slotKeys(date, time, service.minutes),
					status: 'booked',
					source: 'sample',
					demo: true,
				});
				added += 1;
			} catch (error) {
				if (error.code !== 11000) throw error; // slot already taken: just skip it
			}
			if ((await store.appointments.count({ date, demo: true })) >= target) break;
		}
	}
	return added;
}
