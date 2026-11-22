import { Call } from './call.js';

const $ = (sel) => document.querySelector(sel);
const phone = $('.phone');
const statusEl = $('#call-status');
const transcript = $('#transcript');
const activity = $('#activity');
const notice = $('#call-notice');
const callBtn = $('#call-btn');
const muteBtn = $('#mute-btn');
const ring = $('.avatar__ring');

let aiOnline = true;
let maxSeconds = 300;
let lastBubble = null;
let call = null;
let currentDay = null;
let highlight = new Set();

/* ---------- helpers ---------- */

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function fmtDate(date) {
	if (!date) return '';
	const [y, m, d] = date.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function fmtTime(time) {
	const [h, m] = time.split(':').map(Number);
	return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
}

function showNotice(text, tone = 'info') {
	notice.textContent = text;
	notice.dataset.tone = tone;
	notice.hidden = !text;
}

/* ---------- transcript and activity ---------- */

function resetCallUi() {
	transcript.innerHTML = '';
	activity.innerHTML = '';
	lastBubble = null;
	showNotice('');
}

function addTranscript(role, text) {
	if (!text) return;
	if (!lastBubble || lastBubble.dataset.role !== role || lastBubble.dataset.done === '1') {
		lastBubble = document.createElement('p');
		lastBubble.className = `bubble bubble--${role}`;
		lastBubble.dataset.role = role;
		const who = document.createElement('span');
		who.className = 'bubble__who';
		who.textContent = role === 'ava' ? 'Ava' : 'You';
		lastBubble.append(who, document.createElement('span'));
		transcript.append(lastBubble);
	}
	const body = lastBubble.lastChild;
	body.textContent = (body.textContent + text).replace(/\s+/g, ' ').replace(/^\s/, '');
	transcript.scrollTop = transcript.scrollHeight;
}

function closeBubbles() {
	for (const b of transcript.querySelectorAll('.bubble')) b.dataset.done = '1';
}

const TOOL_TEXT = {
	check_availability: (a) => `Checking ${fmtDate(a.date) || 'the calendar'}…`,
	book_appointment: (a) => `Booking ${a.time ? fmtTime(a.time) : ''} on ${fmtDate(a.date)}…`,
	cancel_appointment: () => 'Looking up your appointment…',
	take_message: () => 'Writing a message for the team…',
	end_call: () => 'Ending the call',
};

function toolDone(name, r, item) {
	item.classList.remove('is-busy');
	if (r.error && !r.booked && !r.cancelled && !r.saved) {
		item.classList.add('is-warn');
		if (name === 'check_availability' || name === 'book_appointment') item.querySelector('span').textContent += ' needs another option';
		return;
	}
	item.classList.add('is-done');
	const label = item.querySelector('span');
	if (name === 'check_availability') label.textContent = r.open === false ? `${r.day}: closed` : r.free?.length ? `${r.day}: ${r.free.length}+ free times` : `${r.day}: fully booked`;
	if (name === 'book_appointment' && r.booked) label.textContent = `Booked · ${r.reference} · ${r.day}, ${r.time}`;
	if (name === 'cancel_appointment' && r.cancelled) label.textContent = `Cancelled · ${r.day}, ${r.time}`;
	if (name === 'take_message' && r.saved) label.textContent = 'Message saved for the team';
	if (name === 'end_call') label.textContent = 'Call ended by Ava';
}

const pendingTools = [];
function onTool(msg) {
	if (msg.phase === 'start') {
		const li = document.createElement('li');
		li.className = 'is-busy';
		li.innerHTML = '<i aria-hidden="true"></i><span></span>';
		li.querySelector('span').textContent = (TOOL_TEXT[msg.name] || (() => msg.name))(msg.args || {});
		activity.append(li);
		while (activity.children.length > 4) activity.firstElementChild.remove();
		pendingTools.push({ name: msg.name, li, args: msg.args || {} });
		activity.scrollTop = activity.scrollHeight;
		if (msg.name === 'check_availability' && msg.args?.date) loadSchedule(msg.args.date);
		return;
	}
	const idx = pendingTools.findIndex((p) => p.name === msg.name);
	const entry = idx >= 0 ? pendingTools.splice(idx, 1)[0] : null;
	if (entry) toolDone(msg.name, msg.result || {}, entry.li);
	if ((msg.name === 'book_appointment' && msg.result?.booked) || (msg.name === 'cancel_appointment' && msg.result?.cancelled)) {
		const date = entry?.args.date;
		if (msg.name === 'book_appointment' && date && entry.args.time) highlight.add(`${date}|${entry.args.time}`);
		loadSchedule(date || currentDay);
	}
}

/* ---------- call state ---------- */

function setState(state, detail = {}) {
	phone.dataset.state = state;
	const label = callBtn.querySelector('span');
	muteBtn.hidden = state !== 'live';
	if (state === 'starting') statusEl.textContent = 'Allow the microphone…';
	if (state === 'connecting') statusEl.textContent = 'Connecting to Ava…';
	if (state === 'live') statusEl.textContent = 'On the call · 0:00';
	if (state === 'ending') statusEl.textContent = 'Ending call…';
	if (state === 'starting' || state === 'connecting' || state === 'live') {
		label.textContent = 'Hang up';
		callBtn.classList.add('is-hangup');
	} else {
		label.textContent = state === 'ended' ? 'Call again' : 'Call Ava';
		callBtn.classList.remove('is-hangup');
	}
	if (state === 'ended') {
		closeBubbles();
		muteBtn.setAttribute('aria-pressed', 'false');
		const reasons = {
			ended_by_ava: 'Ava ended the call',
			caller_hung_up: 'You hung up',
			time_limit: 'Demo calls are limited to a few minutes',
		};
		statusEl.textContent = `${reasons[detail.reason] || 'Call ended'}${detail.seconds ? ` · ${clock(detail.seconds)}` : ''}`;
		if (detail.message) showNotice(detail.message, 'error');
		drawRing(0, 0);
	}
}

function onEvent(msg) {
	if (msg.type === 'status' && msg.maxSeconds) maxSeconds = msg.maxSeconds;
	if (msg.type === 'transcript') addTranscript(msg.role, msg.text);
	if (msg.type === 'turn_complete' || msg.type === 'interrupted') closeBubbles();
	if (msg.type === 'tool') onTool(msg);
	if (msg.type === 'time_left') showNotice(`About ${msg.seconds} seconds left on this demo call.`, 'info');
}

/* ---------- avatar ring ---------- */

function drawRing(ava, caller) {
	const g = ring.getContext('2d');
	const { width: w, height: h } = ring;
	g.clearRect(0, 0, w, h);
	const draw = (level, color, base) => {
		const r = base + Math.min(1, level * 2.2) * 26;
		g.beginPath();
		g.arc(w / 2, h / 2, r, 0, Math.PI * 2);
		g.fillStyle = color;
		g.fill();
	};
	draw(caller, 'rgba(233, 162, 59, 0.22)', 74);
	draw(ava, 'rgba(14, 124, 134, 0.22)', 70);
}

function onLevel({ ava, caller, seconds }) {
	drawRing(ava, caller);
	if (phone.dataset.state === 'live') {
		statusEl.textContent = `${muteBtn.getAttribute('aria-pressed') === 'true' ? 'Muted' : ava > 0.04 ? 'Ava is speaking' : 'Listening'} · ${clock(seconds)}`;
	}
}

callBtn.addEventListener('click', async () => {
	if (call && ['starting', 'connecting', 'live'].includes(call.state)) {
		call.hangUp();
		return;
	}
	if (!aiOnline) {
		showNotice('Ava is offline right now: the clinic has not connected the AI yet. You can still browse the appointment book below.', 'error');
		return;
	}
	resetCallUi();
	call = new Call({ onEvent, onState: setState, onLevel });
	await call.start();
});

muteBtn.addEventListener('click', () => {
	const muted = muteBtn.getAttribute('aria-pressed') !== 'true';
	muteBtn.setAttribute('aria-pressed', String(muted));
	muteBtn.querySelector('.sr-only').textContent = muted ? 'Unmute' : 'Mute';
	call?.setMuted(muted);
});

/* ---------- appointment book ---------- */

const daysEl = $('#days');
const board = $('#board');

async function loadSchedule(date) {
	try {
		const res = await fetch(`/api/schedule${date ? `?date=${encodeURIComponent(date)}` : ''}`);
		if (!res.ok) throw new Error();
		renderSchedule(await res.json());
	} catch {
		board.innerHTML = '<p class="muted">Could not load the appointment book.</p>';
	}
}

function renderSchedule(data) {
	currentDay = data.date;
	daysEl.innerHTML = '';
	for (const d of data.days) {
		const b = document.createElement('button');
		b.type = 'button';
		b.role = 'tab';
		b.className = 'day';
		b.setAttribute('aria-selected', String(d.date === data.date));
		b.innerHTML = `<span>${d.label}</span>${d.open ? '' : '<small>Closed</small>'}`;
		b.addEventListener('click', () => loadSchedule(d.date));
		daysEl.append(b);
	}
	if (!data.days.some((d) => d.date === data.date)) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'day';
		b.setAttribute('aria-selected', 'true');
		b.innerHTML = `<span>${fmtDate(data.date).split(',')[0]}</span>`;
		daysEl.append(b);
	}
	if (!data.open) {
		board.innerHTML = `<p class="board__closed">${data.day}: the clinic is closed.</p>`;
		return;
	}
	const free = data.slots.filter((s) => s.state === 'free').length;
	board.innerHTML = `<p class="board__title">${data.day} <span>${free} free half-hour slots</span></p><ol class="slots"></ol>`;
	const list = board.querySelector('.slots');
	for (const s of data.slots) {
		const li = document.createElement('li');
		li.className = `slot slot--${s.state}${s.state === 'booked' && !s.start ? ' slot--cont' : ''}${s.fromCall ? ' slot--call' : ''}${highlight.has(`${data.date}|${s.time}`) ? ' slot--new' : ''}`;
		li.innerHTML = `<time>${fmtTime(s.time)}</time><span></span>`;
		li.querySelector('span').textContent = s.state === 'booked' ? (s.start ? s.service : 'continued') : s.state === 'past' ? '–' : 'Free';
		list.append(li);
	}
}

setInterval(() => {
	if (document.visibilityState === 'visible') loadSchedule(currentDay);
}, 20000);

/* ---------- clinic info ---------- */

async function init() {
	loadSchedule();
	try {
		const info = await (await fetch('/api/clinic')).json();
		aiOnline = info.ai;
		maxSeconds = info.maxCallSeconds;
		if (!aiOnline) statusEl.textContent = 'Offline: AI not connected';
		const tbody = $('#prices tbody');
		tbody.innerHTML = '';
		for (const s of info.services) {
			const tr = document.createElement('tr');
			tr.innerHTML = '<th scope="row"></th><td></td><td></td>';
			tr.children[0].textContent = s.label;
			tr.children[1].textContent = `${s.minutes} min`;
			tr.children[2].textContent = s.price;
			tbody.append(tr);
		}
	} catch {
		/* the page still works without it */
	}
	drawRing(0, 0);
}

init();
