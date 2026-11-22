# Maple Row Dental · AI Phone Receptionist

A working demo of an **AI phone receptionist**. Visitors press **Call Ava**, talk through their microphone, and Ava (Google Gemini Live) answers in a natural voice: she checks the real appointment book, books or cancels appointments, answers questions about prices and opening hours, and takes messages for the team.

> Maple Row Dental is a fictional clinic. It matches the Maple Row Dental WordPress demo.

## What it does

- **Natural voice calls in the browser.** Real-time audio both ways; you can interrupt Ava mid-sentence.
- **Real bookings.** When Ava needs a time, the server checks the calendar and saves the booking. She cannot double-book or invent a slot (the database enforces unique slots).
- **Cancel, reschedule, take messages.** Cancelling needs the phone number the appointment was booked with.
- **Knows the clinic.** Hours, prices, team, insurance and FAQ answers come from one data file (`server/clinic.js`).
- **Safe by design.** Ava says she is an AI, refers emergencies (breathing, spreading swelling, heavy bleeding) to 911, gives no medical advice, and ignores attempts to change her instructions.
- **Live appointment book** on the page that updates as Ava books, without showing names or numbers.
- **Front desk page** at `/admin`: upcoming appointments, messages and a call log.
- **Quota protection.** Calls per visitor per hour, calls per day and call length are limited.

## How it works

```
Browser mic ──16 kHz PCM──►  Node server (/api/call)  ──►  Gemini Live API
Browser speaker ◄─24 kHz PCM─  relay + booking tools  ◄──  voice + tool calls
                                   │
                                   ▼
                                MongoDB (appointments, messages, call log)
```

The API key and the booking tools stay on the server. Because the server sits in the middle, the same relay can be connected to a real phone number later (for example Twilio Media Streams) without changing the booking logic.

## Tech

| Part | Used |
| --- | --- |
| Voice AI | Gemini Live API, `gemini-3.8-live` (free tier available), native audio, function calling |
| Server | Node.js 20+, built-in `http` + `ws` WebSocket relay |
| Database | MongoDB (Mongoose); in-memory store when no database is set |
| Front end | Plain HTML, CSS and JavaScript, AudioWorklet for microphone capture |

## Run it on your laptop

You need **Node.js 20.12 or newer** and a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# open .env and paste your key after GEMINI_API_KEY=
npm start
```

Open http://localhost:3000 and press **Call Ava**. The browser asks for the microphone; allow it. Headphones give the best result.

- Without `MONGODB_URI` the app keeps data in memory (lost on restart).
- Front desk: http://localhost:3000/admin with the `ADMIN_PASSWORD` from `.env`.
- `npm test` runs 11 automated tests, including a full call against a mock of the Gemini Live API.

## Settings

| Variable | Meaning |
| --- | --- |
| `GEMINI_API_KEY` | Google AI Studio key. Required for calls. |
| `GEMINI_LIVE_MODEL` | Live model, default `gemini-3.8-live` |
| `GEMINI_VOICE` | Voice name, default `Kore` (others: Puck, Charon, Aoede, Fenrir...) |
| `MONGODB_URI` | MongoDB connection string. Empty = in-memory data. |
| `ADMIN_PASSWORD` | Password for `/admin`. Required in production. |
| `JWT_SECRET` | Long random text for signing admin log-ins. Required in production. |
| `MAX_CALL_SECONDS` | Longest call allowed (default 300) |
| `CALLS_PER_IP_PER_HOUR` | Calls one visitor can make per hour (default 6) |
| `DAILY_CALL_LIMIT` | Calls the whole site accepts per day (default 150) |

## Deploy for free (Render + MongoDB Atlas)

1. **MongoDB Atlas:** use a free cluster, allow network access from `0.0.0.0/0`, and copy the connection string. Put a database name before the `?`, e.g. `.../maplerow?retryWrites=true...`.
2. **GitHub:** upload this folder to a new repository (without `node_modules` and `.env`).
3. **Render:** New → Web Service → pick the repository.
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
   - Health check path: `/api/health`
   - Environment: `NODE_ENV=production`, `GEMINI_API_KEY`, `MONGODB_URI`, `ADMIN_PASSWORD`, `JWT_SECRET` (Render can generate it)
4. Open the site, press **Call Ava**.

Render supports WebSockets on the free plan. The free service sleeps after 15 minutes without visitors; the first visit after that takes about a minute.

## Customising for a client

- Clinic name, hours, services, prices, team and FAQ: `server/clinic.js`
- What Ava says and her rules: `server/prompt.js`
- Booking rules (slot length, notice, booking window): `server/slots.js`
- Tools Ava can use: `server/tools.js`

## Privacy

During a call, audio is streamed to Google's Gemini API to produce Ava's replies. This app does not record calls or store transcripts. Appointments and messages are deleted automatically a week after the appointment date, and call logs (no audio, no transcript) after 30 days.

---

Built by Muhammad Abdullah as an AI voice agent portfolio demo.
