/**
 * The browser side of a call: microphone in, Ava's voice out, events from the server.
 *
 * Usage:
 *   const call = new Call({ onEvent, onState, onLevel });
 *   await call.start(); call.setMuted(true); call.hangUp();
 */

const OUTPUT_RATE = 24000;

export class Call {
	constructor({ onEvent = () => {}, onState = () => {}, onLevel = () => {} } = {}) {
		this.onEvent = onEvent;
		this.onState = onState;
		this.onLevel = onLevel;
		this.state = 'idle';
		this.muted = false;
		this.sources = new Set();
		this.nextTime = 0;
	}

	setState(state, detail) {
		this.state = state;
		this.onState(state, detail);
	}

	async start() {
		if (this.state !== 'idle' && this.state !== 'ended') return;
		this.setState('starting');
		if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
			this.fail('unsupported', 'This browser cannot make calls. Please use a recent Chrome, Edge, Safari or Firefox.');
			return;
		}
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
			});
		} catch (error) {
			const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
			this.fail('mic', denied ? 'Microphone access was blocked. Allow the microphone in your browser and try again.' : 'No microphone was found.');
			return;
		}

		this.ctx = new AudioContext({ latencyHint: 'interactive' });
		await this.ctx.resume();
		await this.ctx.audioWorklet.addModule('/js/capture-worklet.js');
		this.micSource = this.ctx.createMediaStreamSource(this.stream);
		this.capture = new AudioWorkletNode(this.ctx, 'capture-processor');
		this.micSource.connect(this.capture);
		// The worklet must be pulled by the graph to run; route it to a silent gain.
		this.sink = this.ctx.createGain();
		this.sink.gain.value = 0;
		this.capture.connect(this.sink).connect(this.ctx.destination);

		this.outGain = this.ctx.createGain();
		this.outAnalyser = this.ctx.createAnalyser();
		this.outAnalyser.fftSize = 256;
		this.outGain.connect(this.outAnalyser);
		this.outAnalyser.connect(this.ctx.destination);

		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		this.ws = new WebSocket(`${proto}://${location.host}/api/call`);
		this.ws.binaryType = 'arraybuffer';
		this.setState('connecting');

		this.capture.port.onmessage = ({ data }) => {
			this.micLevel = data.level;
			if (this.state === 'live' && !this.muted && this.ws.readyState === WebSocket.OPEN) this.ws.send(data.pcm);
		};
		this.ws.onmessage = ({ data }) => {
			if (data instanceof ArrayBuffer) this.play(data);
			else this.handle(JSON.parse(data));
		};
		this.ws.onclose = () => {
			if (this.state !== 'ended') this.end(this.endReason || 'dropped');
		};
		this.ws.onerror = () => {
			if (this.state === 'connecting') this.fail('network', 'Could not reach the clinic server. Check your connection and try again.');
		};
		this.meter();
	}

	handle(msg) {
		if (msg.type === 'status' && msg.state === 'ready') {
			this.startedAt = performance.now();
			this.setState('live');
		} else if (msg.type === 'interrupted') {
			this.stopPlayback();
		} else if (msg.type === 'error') {
			this.errorMessage = msg.message;
			this.endReason = msg.code;
		} else if (msg.type === 'end') {
			this.endReason = msg.reason;
		}
		this.onEvent(msg);
	}

	play(buffer) {
		if (!this.ctx) return;
		const pcm = new Int16Array(buffer);
		const audio = this.ctx.createBuffer(1, pcm.length, OUTPUT_RATE);
		const channel = audio.getChannelData(0);
		for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 0x8000;
		const src = this.ctx.createBufferSource();
		src.buffer = audio;
		src.connect(this.outGain);
		const now = this.ctx.currentTime;
		if (this.nextTime < now + 0.03) this.nextTime = now + 0.06; // small cushion against network jitter
		src.start(this.nextTime);
		this.nextTime += audio.duration;
		this.sources.add(src);
		src.onended = () => this.sources.delete(src);
	}

	stopPlayback() {
		for (const src of this.sources) {
			try {
				src.stop();
			} catch {
				/* already stopped */
			}
		}
		this.sources.clear();
		this.nextTime = 0;
	}

	/** Seconds of Ava's voice still queued. */
	pending() {
		return this.ctx ? Math.max(0, this.nextTime - this.ctx.currentTime) : 0;
	}

	meter() {
		if (!this.outAnalyser) return;
		const data = new Uint8Array(this.outAnalyser.fftSize);
		const tick = () => {
			if (!this.outAnalyser) return;
			this.outAnalyser.getByteTimeDomainData(data);
			let peak = 0;
			for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
			this.onLevel({ ava: peak, caller: this.muted ? 0 : this.micLevel || 0, seconds: this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0 });
			this.raf = requestAnimationFrame(tick);
		};
		tick();
	}

	setMuted(muted) {
		this.muted = muted;
		this.stream?.getAudioTracks().forEach((t) => {
			t.enabled = !muted;
		});
	}

	hangUp() {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'hangup' }));
		this.stopPlayback();
		this.end('caller_hung_up');
	}

	fail(code, message) {
		this.errorMessage = message;
		this.end(code);
	}

	async end(reason) {
		if (this.state === 'ended') return;
		const seconds = this.startedAt ? Math.round((performance.now() - this.startedAt) / 1000) : 0;
		this.setState('ending');
		// Let Ava finish her goodbye before closing the audio.
		const wait = reason === 'caller_hung_up' ? 0 : Math.min(this.pending(), 6);
		if (wait) await new Promise((r) => setTimeout(r, wait * 1000 + 150));
		cancelAnimationFrame(this.raf);
		this.capture?.port.close();
		this.stream?.getTracks().forEach((t) => t.stop());
		if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
		await this.ctx?.close().catch(() => {});
		this.ctx = null;
		this.outAnalyser = null;
		this.sources.clear();
		this.startedAt = 0;
		this.setState('ended', { reason, seconds, message: this.errorMessage });
		this.errorMessage = '';
		this.endReason = '';
	}
}
