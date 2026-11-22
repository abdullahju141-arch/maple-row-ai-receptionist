/**
 * Reads settings from environment variables (and a local .env file if present).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
	process.loadEnvFile(envFile);
}

const env = process.env;
const production = env.NODE_ENV === 'production';
const int = (value, fallback) => {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

if (production && !env.JWT_SECRET) {
	throw new Error('JWT_SECRET must be set in production.');
}
if (production && (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD === 'change-me-please')) {
	throw new Error('ADMIN_PASSWORD must be set to your own password in production.');
}

export const config = {
	root,
	production,
	port: int(env.PORT, 3000),
	mongoUri: (env.MONGODB_URI || '').trim(),
	geminiApiKey: (env.GEMINI_API_KEY || '').trim(),
	liveModel: (env.GEMINI_LIVE_MODEL || 'gemini-3.8-live').trim(),
	voice: (env.GEMINI_VOICE || 'Kore').trim(),
	// Overridable so tests can point the relay at a local mock of the Live API.
	liveUrl: env.GEMINI_LIVE_URL || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
	adminPassword: env.ADMIN_PASSWORD || 'admin-pass-123',
	jwtSecret: env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
	maxCallSeconds: int(env.MAX_CALL_SECONDS, 300),
	callsPerIpPerHour: int(env.CALLS_PER_IP_PER_HOUR, 6),
	dailyCallLimit: int(env.DAILY_CALL_LIMIT, 150),
};
