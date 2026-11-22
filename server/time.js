/**
 * Date helpers that work in the clinic's time zone, whatever time zone the server runs in.
 * Dates are 'YYYY-MM-DD' strings and times are 'HH:MM' (24h) in clinic local time.
 */

import { CLINIC } from './clinic.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');

/** Current date and time at the clinic. */
export function clinicNow(now = new Date(), timeZone = CLINIC.timeZone) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		})
			.formatToParts(now)
			.map((p) => [p.type, p.value]),
	);
	const date = `${parts.year}-${parts.month}-${parts.day}`;
	const time = `${parts.hour}:${parts.minute}`;
	return { date, time, minutes: toMinutes(time) };
}

export function isDate(value) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [y, m, d] = value.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isTime(value) {
	return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function weekday(date) {
	const [y, m, d] = date.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayName(date) {
	return WEEKDAYS[weekday(date)];
}

export function addDays(date, days) {
	const [y, m, d] = date.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d + days));
	return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysBetween(from, to) {
	const a = Date.UTC(...from.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
	const b = Date.UTC(...to.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
	return Math.round((b - a) / 86_400_000);
}

export function toMinutes(time) {
	const [h, m] = time.split(':').map(Number);
	return h * 60 + m;
}

export function fromMinutes(total) {
	return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** "Tuesday 24 November" */
export function spokenDate(date) {
	const [, m, d] = date.split('-').map(Number);
	return `${weekdayName(date)} ${d} ${MONTHS[m - 1]}`;
}

/** "2:30pm", "9am" */
export function spokenTime(time) {
	const [h, m] = time.split(':').map(Number);
	const suffix = h >= 12 ? 'pm' : 'am';
	const h12 = h % 12 === 0 ? 12 : h % 12;
	return m ? `${h12}:${pad(m)}${suffix}` : `${h12}${suffix}`;
}
