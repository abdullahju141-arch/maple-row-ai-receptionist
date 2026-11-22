/**
 * HTTP routes (no framework): public schedule board, clinic info, admin API and static files.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { CLINIC, HOURS, HOURS_TEXT, SERVICES, TEAM } from './clinic.js';
import { HttpError, rateLimiter, readJson, samePassword, signToken, verifyToken } from './http.js';
import { opening, SLOT_MINUTES, MIN_NOTICE_MINUTES } from './slots.js';
import { addDays, clinicNow, fromMinutes, isDate, spokenDate, toMinutes } from './time.js';

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
	'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
	res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
	res.end(body);
}

function json(res, status, data) {
	send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function clientIp(req) {
	return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

export function createApp({ config, store, now = () => new Date() }) {
	const publicDir = path.join(config.root, 'public');
	const loginLimit = rateLimiter(10, 15 * 60 * 1000);

	const requireAdmin = (req) => {
		const header = req.headers.authorization || '';
		const payload = verifyToken(header.replace(/^Bearer\s+/i, ''), config.jwtSecret);
		if (!payload || payload.role !== 'admin') throw new HttpError(401, 'Please log in.');
	};

	async function schedule(url) {
		const today = clinicNow(now());
		const date = isDate(url.searchParams.get('date')) ? url.searchParams.get('date') : today.date;
		const days = Array.from({ length: 7 }, (_, i) => {
			const d = addDays(today.date, i);
			return { date: d, label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : spokenDate(d).split(' ').slice(0, 2).join(' '), open: Boolean(opening(d)) };
		});
		const hours = opening(date);
		const rows = hours ? await store.appointments.find({ date, status: 'booked' }) : [];
		const byKey = new Map();
		for (const r of rows) for (const key of r.slotKeys || []) byKey.set(key, r);
		const slots = [];
		if (hours) {
			for (let t = toMinutes(hours[0]); t < toMinutes(hours[1]); t += SLOT_MINUTES) {
				const time = fromMinutes(t);
				const appt = byKey.get(`${date}|${time}`);
				const past = date < today.date || (date === today.date && t < today.minutes + MIN_NOTICE_MINUTES);
				slots.push({
					time,
					state: appt ? 'booked' : past ? 'past' : 'free',
					service: appt ? SERVICES[appt.service]?.short || appt.serviceLabel : undefined,
					start: appt ? appt.time === time : undefined,
					fromCall: appt ? appt.source === 'ai-call' : undefined,
				});
			}
		}
		return { date, day: spokenDate(date), open: Boolean(hours), hours, slots, days, now: today };
	}

	const routes = {
		'GET /api/health': async () => ({ ok: true, store: store.kind, ai: Boolean(config.geminiApiKey), model: config.liveModel }),
		'GET /api/clinic': async () => ({
			clinic: CLINIC,
			hours: HOURS,
			hoursText: HOURS_TEXT,
			team: TEAM,
			services: Object.entries(SERVICES).map(([id, s]) => ({ id, label: s.label, minutes: s.minutes, price: s.price })),
			ai: Boolean(config.geminiApiKey),
			maxCallSeconds: config.maxCallSeconds,
		}),
		'GET /api/schedule': async (req, url) => schedule(url),
		'POST /api/admin/login': async (req) => {
			if (!loginLimit(clientIp(req))) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
			const body = await readJson(req);
			if (!body.password || !samePassword(body.password, config.adminPassword)) throw new HttpError(401, 'Wrong password.');
			return { token: signToken({ role: 'admin' }, config.jwtSecret) };
		},
		'GET /api/admin/data': async (req) => {
			requireAdmin(req);
			const today = clinicNow(now()).date;
			const [appointments, messages, calls] = await Promise.all([
				store.appointments.find({ demo: false, date: { $gte: addDays(today, -7) } }, { sort: { date: 1, time: 1 } }),
				store.messages.find({}, { sort: { createdAt: -1 }, limit: 100 }),
				store.calls.find({}, { sort: { startedAt: -1 }, limit: 50 }),
			]);
			return { today, appointments, messages, calls };
		},
	};

	const paramRoutes = [
		[
			'POST',
			/^\/api\/admin\/appointments\/([\w-]+)\/cancel$/,
			async (req, id) => {
				requireAdmin(req);
				const updated = await store.appointments.update(id, { status: 'cancelled', slotKeys: [] });
				if (!updated) throw new HttpError(404, 'Appointment not found.');
				return { appointment: updated };
			},
		],
		[
			'POST',
			/^\/api\/admin\/messages\/([\w-]+)\/handled$/,
			async (req, id) => {
				requireAdmin(req);
				const updated = await store.messages.update(id, { status: 'handled' });
				if (!updated) throw new HttpError(404, 'Message not found.');
				return { message: updated };
			},
		],
		[
			'DELETE',
			/^\/api\/admin\/messages\/([\w-]+)$/,
			async (req, id) => {
				requireAdmin(req);
				if (!(await store.messages.remove(id))) throw new HttpError(404, 'Message not found.');
				return { ok: true };
			},
		],
	];

	async function serveStatic(req, res, pathname) {
		let file = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
		file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
		const full = path.join(publicDir, file);
		if (!full.startsWith(publicDir)) return send(res, 403, 'Forbidden');
		try {
			const data = await fs.readFile(full);
			const ext = path.extname(full);
			const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
			send(res, 200, req.method === 'HEAD' ? undefined : data, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache });
		} catch {
			const notFound = await fs.readFile(path.join(publicDir, '404.html')).catch(() => 'Not found');
			send(res, 404, notFound, { 'Content-Type': 'text/html; charset=utf-8' });
		}
	}

	return async function handle(req, res) {
		const url = new URL(req.url, 'http://localhost');
		const { pathname } = url;
		try {
			if (pathname.startsWith('/api/')) {
				const route = routes[`${req.method} ${pathname}`];
				if (route) return json(res, 200, await route(req, url));
				for (const [method, pattern, handler] of paramRoutes) {
					const match = req.method === method && pattern.exec(pathname);
					if (match) return json(res, 200, await handler(req, match[1]));
				}
				throw new HttpError(404, 'Not found.');
			}
			if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
			return serveStatic(req, res, pathname);
		} catch (error) {
			const status = error.status || 500;
			if (status >= 500) console.error('[http]', error);
			return json(res, status, { error: status >= 500 ? 'Something went wrong. Please try again.' : error.message });
		}
	};
}
