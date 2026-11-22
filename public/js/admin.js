const $ = (sel) => document.querySelector(sel);
const KEY = 'mrd.admin';

const getToken = () => {
	try {
		return sessionStorage.getItem(KEY) || '';
	} catch {
		return '';
	}
};
const setToken = (t) => {
	try {
		if (t) sessionStorage.setItem(KEY, t);
		else sessionStorage.removeItem(KEY);
	} catch {
		/* private mode */
	}
};

async function api(path, options = {}) {
	const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...(options.headers || {}) } });
	const data = await res.json().catch(() => ({}));
	if (res.status === 401) {
		setToken('');
		show('login');
	}
	if (!res.ok) throw new Error(data.error || 'Request failed.');
	return data;
}

function show(which) {
	$('#login').hidden = which !== 'login';
	$('#dash').hidden = which !== 'dash';
}

const cell = (text) => {
	const td = document.createElement('td');
	td.textContent = text ?? '';
	return td;
};

function when(date, time) {
	const [y, m, d] = date.split('-').map(Number);
	const day = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
	const [h, min] = time.split(':').map(Number);
	return `${day}, ${h % 12 || 12}:${String(min).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
}

const stamp = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

function tag(text, kind = '') {
	const span = document.createElement('span');
	span.className = `tag ${kind}`;
	span.textContent = text;
	return span;
}

function button(label, onClick) {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = 'btn btn--small';
	b.textContent = label;
	b.addEventListener('click', onClick);
	return b;
}

function empty(tbody, cols, text) {
	const tr = document.createElement('tr');
	const td = cell(text);
	td.colSpan = cols;
	td.className = 'muted';
	tr.append(td);
	tbody.append(tr);
}

async function load() {
	const data = await api('/api/admin/data');
	const upcoming = data.appointments.filter((a) => a.date >= data.today);
	const booked = upcoming.filter((a) => a.status === 'booked');
	const kpis = [
		[booked.length, 'upcoming bookings'],
		[data.appointments.filter((a) => a.date === data.today && a.status === 'booked').length, 'booked for today'],
		[data.messages.filter((m) => m.status === 'new').length, 'new messages'],
		[data.calls.length, 'recent calls'],
	];
	$('#kpis').innerHTML = '';
	for (const [n, label] of kpis) {
		const li = document.createElement('li');
		li.innerHTML = '<strong></strong><span></span>';
		li.firstChild.textContent = n;
		li.lastChild.textContent = label;
		$('#kpis').append(li);
	}

	const appts = $('#appts');
	appts.innerHTML = '';
	if (!data.appointments.length) empty(appts, 7, 'No bookings from calls yet. Call Ava and book one!');
	for (const a of data.appointments) {
		const tr = document.createElement('tr');
		tr.append(cell(when(a.date, a.time)), cell(`${a.patientName}${a.newPatient ? ' (new)' : ''}`), cell(a.phone), cell(a.serviceLabel), cell(a.notes || ''));
		const status = document.createElement('td');
		status.append(tag(a.status === 'booked' ? a.reference : `Cancelled · ${a.reference}`, a.status === 'booked' ? '' : 'tag--off'));
		const actions = document.createElement('td');
		if (a.status === 'booked' && a.date >= data.today) {
			actions.append(
				button('Cancel', async () => {
					if (!window.confirm(`Cancel ${a.patientName}'s appointment?`)) return;
					await api(`/api/admin/appointments/${a.id}/cancel`, { method: 'POST' });
					load();
				}),
			);
		}
		tr.append(status, actions);
		appts.append(tr);
	}

	const messages = $('#messages');
	messages.innerHTML = '';
	if (!data.messages.length) empty(messages, 6, 'No messages.');
	for (const m of data.messages) {
		const tr = document.createElement('tr');
		tr.append(cell(stamp(m.createdAt)), cell(m.name), cell(m.phone), cell(m.message));
		const status = document.createElement('td');
		status.append(tag(m.status === 'new' ? (m.urgent ? 'Urgent' : 'New') : 'Handled', m.status === 'new' ? (m.urgent ? 'tag--urgent' : '') : 'tag--off'));
		const actions = document.createElement('td');
		if (m.status === 'new') actions.append(button('Mark handled', async () => { await api(`/api/admin/messages/${m.id}/handled`, { method: 'POST' }); load(); }));
		actions.append(' ', button('Delete', async () => { await api(`/api/admin/messages/${m.id}`, { method: 'DELETE' }); load(); }));
		tr.append(status, actions);
		messages.append(tr);
	}

	const calls = $('#calls');
	calls.innerHTML = '';
	if (!data.calls.length) empty(calls, 4, 'No calls yet.');
	const names = { check_availability: 'checked times', book_appointment: 'booked', cancel_appointment: 'cancelled', take_message: 'took a message', end_call: 'hung up' };
	const reasons = { ended_by_ava: 'Ava said goodbye', caller_hung_up: 'Caller hung up', time_limit: 'Time limit', dropped: 'Dropped', connect_failed: 'Could not connect' };
	for (const c of data.calls) {
		const tr = document.createElement('tr');
		const did = [...new Set((c.toolsUsed || []).map((t) => names[t] || t))].join(', ') || 'answered questions';
		tr.append(cell(stamp(c.startedAt)), cell(`${Math.floor((c.seconds || 0) / 60)}:${String((c.seconds || 0) % 60).padStart(2, '0')}`), cell(did + (c.booked?.length ? ` (${c.booked.join(', ')})` : '')), cell(reasons[c.endReason] || c.endReason));
		calls.append(tr);
	}
	show('dash');
}

$('#login').addEventListener('submit', async (event) => {
	event.preventDefault();
	const err = $('#login-error');
	err.hidden = true;
	try {
		const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: event.target.password.value }) });
		const data = await res.json();
		if (!res.ok) throw new Error(data.error);
		setToken(data.token);
		event.target.reset();
		await load();
	} catch (error) {
		err.textContent = error.message || 'Could not log in.';
		err.hidden = false;
	}
});

$('#logout').addEventListener('click', () => {
	setToken('');
	show('login');
});

if (getToken()) load().catch(() => show('login'));
else show('login');
setInterval(() => {
	if (!$('#dash').hidden && document.visibilityState === 'visible') load().catch(() => {});
}, 30000);
