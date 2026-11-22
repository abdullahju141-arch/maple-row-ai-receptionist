/**
 * Starts the web server and the call relay.
 */

import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { attachRelay } from './relay.js';
import { createStore, ensureSampleBookings } from './store/index.js';

const store = await createStore(config);
await ensureSampleBookings(store);
// Keep sample bookings on the calendar as the days roll forward.
setInterval(() => ensureSampleBookings(store).catch((e) => console.error('[seed]', e.message)), 60 * 60 * 1000).unref();

const server = http.createServer(createApp({ config, store }));
attachRelay(server, { config, store });

server.listen(config.port, () => {
	console.log(`Maple Row Dental AI receptionist on http://localhost:${config.port}`);
	console.log(`Data: ${store.kind === 'mongo' ? 'MongoDB' : 'in-memory (set MONGODB_URI to keep data)'}`);
	console.log(`AI: ${config.geminiApiKey ? `${config.liveModel}, voice ${config.voice}` : 'OFFLINE (set GEMINI_API_KEY)'}`);
});

const shutdown = async () => {
	server.close();
	await store.close();
	process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
