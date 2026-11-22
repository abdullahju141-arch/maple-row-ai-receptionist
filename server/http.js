/**
 * Small HTTP helpers: errors, JSON bodies, rate limiting and signed admin tokens.
 */

import crypto from 'node:crypto';

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export function rateLimiter(limit, windowMs) {
	const hits = new Map();
	return (key) => {
		const now = Date.now();
		const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
		if (list.length >= limit) {
			hits.set(key, list);
			return false;
		}
		list.push(now);
		hits.set(key, list);
		if (hits.size > 5000) {
			for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
		}
		return true;
	};
}

export function readJson(req, maxBytes = 10_000) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new HttpError(413, 'Request too large.'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch {
				reject(new HttpError(400, 'Invalid JSON.'));
			}
		});
		req.on('error', reject);
	});
}

const b64 = (value) => Buffer.from(value).toString('base64url');

export function signToken(payload, secret, ttlSeconds = 12 * 60 * 60) {
	const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
	const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
	return `${body}.${sig}`;
}

export function verifyToken(token, secret) {
	if (typeof token !== 'string' || !token.includes('.')) return null;
	const [body, sig] = token.split('.');
	const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
	if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
	try {
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
		return payload.exp > Date.now() / 1000 ? payload : null;
	} catch {
		return null;
	}
}

/** Constant-time password comparison. */
export function samePassword(given, expected) {
	const a = crypto.createHash('sha256').update(String(given)).digest();
	const b = crypto.createHash('sha256').update(String(expected)).digest();
	return crypto.timingSafeEqual(a, b);
}
