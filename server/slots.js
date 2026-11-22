/**
 * Appointment slots. The day is split into 30-minute blocks; a booking takes as many
 * blocks as its service needs and stores them as `slotKeys` ('2026-11-24|09:30'),
 * which the database keeps unique so two calls can never book the same time.
 */

import { HOURS } from './clinic.js';
import { addDays, clinicNow, fromMinutes, toMinutes, weekday } from './time.js';

export const SLOT_MINUTES = 30;
export const BOOKING_WINDOW_DAYS = 60;
/** Same-day bookings need this much notice. */
export const MIN_NOTICE_MINUTES = 60;

export function opening(date) {
	return HOURS[weekday(date)] || null;
}

export function slotKeys(date, time, minutes) {
	const start = toMinutes(time);
	const keys = [];
	for (let t = start; t < start + minutes; t += SLOT_MINUTES) {
		keys.push(`${date}|${fromMinutes(t)}`);
	}
	return keys;
}

/** Every start time on `date` where a `minutes`-long appointment fits inside opening hours. */
export function startTimes(date, minutes) {
	const hours = opening(date);
	if (!hours) return [];
	const open = toMinutes(hours[0]);
	const close = toMinutes(hours[1]);
	const out = [];
	for (let t = open; t + minutes <= close; t += SLOT_MINUTES) {
		out.push(fromMinutes(t));
	}
	return out;
}

/**
 * Free start times on `date` for an appointment of `minutes`.
 *
 * @param {string} date
 * @param {number} minutes
 * @param {Set<string>} taken Slot keys already booked.
 * @param {Date} now
 */
export function freeTimes(date, minutes, taken, now = new Date()) {
	const today = clinicNow(now);
	if (date < today.date) return [];
	return startTimes(date, minutes).filter((time) => {
		if (date === today.date && toMinutes(time) < today.minutes + MIN_NOTICE_MINUTES) return false;
		return slotKeys(date, time, minutes).every((key) => !taken.has(key));
	});
}

/** Pick up to `max` times spread across the day, so the caller hears morning and afternoon options. */
export function spread(times, max = 6) {
	if (times.length <= max) return times;
	const out = [];
	for (let i = 0; i < max; i += 1) {
		out.push(times[Math.round((i * (times.length - 1)) / (max - 1))]);
	}
	return [...new Set(out)];
}

export function lastBookableDate(now = new Date()) {
	return addDays(clinicNow(now).date, BOOKING_WINDOW_DAYS);
}
