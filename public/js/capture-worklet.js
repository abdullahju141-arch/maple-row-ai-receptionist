/**
 * AudioWorklet: takes microphone audio at the browser's sample rate (usually 48 kHz),
 * resamples it to 16 kHz mono and posts 40 ms chunks of 16-bit PCM to the page.
 */
class CaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.ratio = sampleRate / 16000;
		this.pos = 0; // fractional read position into the incoming stream
		this.prev = 0; // last sample of the previous block, for interpolation across blocks
		this.out = new Int16Array(640);
		this.fill = 0;
		this.level = 0;
	}

	process(inputs) {
		const input = inputs[0] && inputs[0][0];
		if (!input) return true;
		let peak = 0;
		while (this.pos < input.length) {
			const i = Math.floor(this.pos);
			const frac = this.pos - i;
			const a = i === 0 ? this.prev : input[i - 1];
			const b = input[i];
			const s = a + (b - a) * frac;
			const v = Math.max(-1, Math.min(1, s));
			if (Math.abs(v) > peak) peak = Math.abs(v);
			this.out[this.fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
			if (this.fill === this.out.length) {
				this.port.postMessage({ pcm: this.out.buffer, level: this.level }, [this.out.buffer]);
				this.out = new Int16Array(640);
				this.fill = 0;
			}
			this.pos += this.ratio;
		}
		this.pos -= input.length;
		this.prev = input[input.length - 1];
		this.level = Math.max(peak, this.level * 0.9);
		return true;
	}
}

registerProcessor('capture-processor', CaptureProcessor);
