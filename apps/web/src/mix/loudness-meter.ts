/**
 * EBU R128 / ITU-R BS.1770-4 loudness and true peak of a rendered mix, and the
 * ceiling that keeps its true peak under a limit. Plain arithmetic on sample
 * arrays, so the same code measures the final preview's mix and masters the
 * export, and runs under tests without Web Audio.
 */

/** One stretch of audio: a Float32Array per channel, all the same length. */
export interface MixAudio {
	channels: Float32Array[];
	sampleRate: number;
}

export interface MixMeasurement {
	/** Null when no block passes the gates: silence, or under 400 ms. */
	integratedLufs: number | null;
	/** Null for silence. */
	truePeakDbtp: number | null;
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1;
/** Samples handled between yields, so a long mix doesn't freeze the editor. */
const SLICE_SAMPLES = 1 << 18;

const toDb = (linear: number) => 20 * Math.log10(linear);
export const dbToLinear = (db: number) => 10 ** (db / 20);

/** The K-weighting pre-filter and RLB high-pass, as BS.1770 defines them, at any rate. */
function kWeighting(sampleRate: number) {
	let f0 = 1681.974450955533;
	const gain = 3.999843853973347;
	let q = 0.7071752369554196;
	let k = Math.tan((Math.PI * f0) / sampleRate);
	const vh = 10 ** (gain / 20);
	const vb = vh ** 0.4996667741545416;
	let a0 = 1 + k / q + k * k;
	const shelf = {
		b: [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
		a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
	};
	f0 = 38.13547087602444;
	q = 0.5003270373238773;
	k = Math.tan((Math.PI * f0) / sampleRate);
	a0 = 1 + k / q + k * k;
	const highPass = {
		b: [1, -2, 1],
		a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
	};
	return [shelf, highPass];
}

/** Half the taps either side of the point a true-peak sample is read at. */
const INTERPOLATION_HALF_TAPS = 6;
/** BS.1770 reads true peak from 4× oversampling: three points between each pair. */
const INTERPOLATION_PHASES = [0.25, 0.5, 0.75].map((fraction) => {
	const taps: number[] = [];
	for (let j = 1 - INTERPOLATION_HALF_TAPS; j <= INTERPOLATION_HALF_TAPS; j++) {
		const t = fraction - j;
		const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
		const window = 0.5 * (1 + Math.cos((Math.PI * t) / INTERPOLATION_HALF_TAPS));
		taps.push(sinc * window);
	}
	const sum = taps.reduce((total, tap) => total + tap, 0);
	return taps.map((tap) => tap / sum);
});
/** No interpolated point can exceed the largest sample nearby by more than this. */
const INTERPOLATION_BOUND = Math.max(
	...INTERPOLATION_PHASES.map((taps) =>
		taps.reduce((total, tap) => total + Math.abs(tap), 0),
	),
);

/** The largest magnitude among the points 4× oversampling reads between `index` and the next sample. */
function interpolatedPeak({
	data,
	index,
}: {
	data: Float32Array;
	index: number;
}): number {
	let peak = 0;
	const first = index + 1 - INTERPOLATION_HALF_TAPS;
	for (const taps of INTERPOLATION_PHASES) {
		let value = 0;
		for (let tap = 0; tap < taps.length; tap++) {
			const sample = data[first + tap];
			// Past either end, the signal is silent.
			if (sample !== undefined) value += sample * taps[tap];
		}
		const magnitude = Math.abs(value);
		if (magnitude > peak) peak = magnitude;
	}
	return peak;
}

function maxMagnitude({
	data,
	from,
	to,
}: {
	data: Float32Array;
	from: number;
	to: number;
}): number {
	let peak = 0;
	for (let index = Math.max(0, from); index < Math.min(data.length, to); index++) {
		const magnitude = Math.abs(data[index]);
		if (magnitude > peak) peak = magnitude;
	}
	return peak;
}


const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Points either side of a sample whose 4× oversampled peak can be read. */
const HISTORY = 2 * INTERPOLATION_HALF_TAPS;

/**
 * Measures loudness and true peak of audio fed to it a slice at a time, so a
 * long mix is measured without holding a second copy of it.
 */
export class MixMeter {
	private readonly filters: ReturnType<typeof kWeighting>;
	private readonly state: Array<Array<{ x1: number; x2: number; y1: number; y2: number }>>;
	private readonly stepLength: number;
	private readonly stepPowers: number[] = [];
	private stepSum = 0;
	private stepFill = 0;
	/** The last samples of each channel, to read true peak across slice joins. */
	private history: Float32Array[];
	private peak = 0;
	/** A mono mix plays on both channels. */
	private readonly channelWeight: number;

	constructor({
		sampleRate,
		channelCount,
	}: {
		sampleRate: number;
		channelCount: number;
	}) {
		this.filters = kWeighting(sampleRate);
		this.state = Array.from({ length: channelCount }, () =>
			this.filters.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 })),
		);
		this.stepLength = Math.round(STEP_SECONDS * sampleRate);
		this.history = Array.from(
			{ length: channelCount },
			() => new Float32Array(HISTORY),
		);
		this.channelWeight = channelCount === 1 ? 2 : 1;
	}

	add(slice: Float32Array[]): void {
		const length = slice[0]?.length ?? 0;
		if (length === 0) return;
		const weighted = new Float64Array(length);
		slice.forEach((data, channel) => {
			const state = this.state[channel];
			for (let index = 0; index < length; index++) {
				let value = data[index];
				for (let stage = 0; stage < this.filters.length; stage++) {
					const { b, a } = this.filters[stage];
					const s = state[stage];
					const out =
						b[0] * value + b[1] * s.x1 + b[2] * s.x2 - a[0] * s.y1 - a[1] * s.y2;
					s.x2 = s.x1;
					s.x1 = value;
					s.y2 = s.y1;
					s.y1 = out;
					value = out;
				}
				weighted[index] += value * value * this.channelWeight;
			}
			this.readPeak({ channel, data });
		});
		for (let index = 0; index < length; index++) {
			this.stepSum += weighted[index];
			if (++this.stepFill === this.stepLength) {
				this.stepPowers.push(this.stepSum / this.stepLength);
				this.stepSum = 0;
				this.stepFill = 0;
			}
		}
	}

	/**
	 * Reads the points between every pair of samples whose neighbours are all
	 * here: the last few wait for the next slice, or for `finish`.
	 */
	private readPeak({
		channel,
		data,
	}: {
		channel: number;
		data: Float32Array;
	}): void {
		const joined = new Float32Array(HISTORY + data.length);
		joined.set(this.history[channel]);
		joined.set(data, HISTORY);
		this.peak = Math.max(
			this.peak,
			maxMagnitude({ data, from: 0, to: data.length }),
			truePeakBetween({
				data: joined,
				from: INTERPOLATION_HALF_TAPS,
				to: joined.length - INTERPOLATION_HALF_TAPS,
				floor: this.peak,
			}),
		);
		this.history[channel] = joined.slice(joined.length - HISTORY);
	}

	finish(): MixMeasurement {
		// Silence after the end lets the last points be read.
		const tail = Array.from(
			{ length: this.history.length },
			() => new Float32Array(INTERPOLATION_HALF_TAPS),
		);
		tail.forEach((data, channel) => this.readPeak({ channel, data }));
		const stepsPerBlock = Math.round(BLOCK_SECONDS / STEP_SECONDS);
		const blocks: number[] = [];
		const steps = this.stepPowers;
		for (let first = 0; first + stepsPerBlock <= steps.length; first++) {
			let sum = 0;
			for (let step = first; step < first + stepsPerBlock; step++)
				sum += steps[step];
			blocks.push(sum / stepsPerBlock);
		}
		return {
			integratedLufs: gatedLoudness(blocks),
			truePeakDbtp: this.peak > 0 ? toDb(this.peak) : null,
		};
	}
}

/** The largest magnitude 4× oversampling reads between samples `from`–`to` and the next, skipping stretches that can't beat `floor`. */
function truePeakBetween({
	data,
	from,
	to,
	floor,
}: {
	data: Float32Array;
	from: number;
	to: number;
	floor: number;
}): number {
	let peak = floor;
	const chunk = 256;
	for (let start = from; start < to; start += chunk) {
		const end = Math.min(to, start + chunk);
		const nearby = maxMagnitude({
			data,
			from: start - INTERPOLATION_HALF_TAPS,
			to: end + INTERPOLATION_HALF_TAPS,
		});
		if (nearby * INTERPOLATION_BOUND <= peak) continue;
		for (let index = start; index < end; index++) {
			const between = interpolatedPeak({ data, index });
			if (between > peak) peak = between;
		}
	}
	return peak;
}

const blockLoudness = (power: number) => -0.691 + 10 * Math.log10(power);

/** BS.1770's two gates over the 400 ms block powers. */
export function gatedLoudness(blocks: number[]): number | null {
	const loud = blocks.filter(
		(power) => power > 0 && blockLoudness(power) > ABSOLUTE_GATE_LUFS,
	);
	if (loud.length === 0) return null;
	const mean = (values: number[]) =>
		values.reduce((total, value) => total + value, 0) / values.length;
	const relativeGate = blockLoudness(mean(loud)) + RELATIVE_GATE_LU;
	const gated = loud.filter((power) => blockLoudness(power) > relativeGate);
	return gated.length === 0 ? null : blockLoudness(mean(gated));
}

function* slices({ length }: { length: number }) {
	for (let start = 0; start < length; start += SLICE_SAMPLES)
		yield { start, end: Math.min(length, start + SLICE_SAMPLES) };
}

/** Integrated loudness and true peak of a whole mix. Yields to the event loop between slices. */
export async function measureMix({
	audio: { channels, sampleRate },
	signal,
}: {
	audio: MixAudio;
	signal?: AbortSignal;
}): Promise<MixMeasurement> {
	const meter = new MixMeter({ sampleRate, channelCount: channels.length });
	for (const { start, end } of slices({ length: channels[0]?.length ?? 0 })) {
		signal?.throwIfAborted();
		meter.add(channels.map((data) => data.subarray(start, end)));
		await pause();
	}
	return meter.finish();
}

/** Look-ahead of the ceiling: it starts lowering the gain this early. */
const LOOKAHEAD_SECONDS = 0.005;
/** How fast the ceiling lets the gain recover after a peak. */
const RELEASE_DB_PER_SECOND = 20;
/** Room for the gain changing between samples. */
const CEILING_MARGIN_DB = 0.1;

/**
 * The gain of each sample once `gainDb` is applied and the true peak is held
 * at or under `ceilingDbtp`, a slice at a time. The gain dips ahead of each
 * peak over a short look-ahead and recovers gently after it, so loud passages
 * keep their shape instead of being clipped.
 */
async function* mixGains({
	audio: { channels, sampleRate },
	gainDb,
	ceilingDbtp,
	signal,
}: {
	audio: MixAudio;
	gainDb: number;
	ceilingDbtp: number;
	signal?: AbortSignal;
}): AsyncGenerator<{ start: number; end: number; gains: Float32Array }> {
	const length = channels[0]?.length ?? 0;
	const gain = dbToLinear(gainDb);
	const ceiling = dbToLinear(ceilingDbtp - CEILING_MARGIN_DB);
	const lookahead = Math.max(1, Math.round(LOOKAHEAD_SECONDS * sampleRate));
	const releasePerSample = RELEASE_DB_PER_SECOND / sampleRate;

	// The look-ahead's lowest needed gain, as a monotonic queue of (index, gain).
	const queueIndex = new Int32Array(lookahead + 2);
	const queueGain = new Float32Array(lookahead + 2);
	let head = 0;
	let tail = 0;
	const size = queueIndex.length;
	// Averaging the released gain over the look-ahead keeps it from stepping.
	const released = new Float32Array(lookahead).fill(1);
	let releasedSum = lookahead;
	let releasedDb = 0;
	let pushed = 0;

	for (const { start, end } of slices({ length })) {
		signal?.throwIfAborted();
		// What each sample needs: no point between it and either neighbour over the ceiling.
		const from = Math.max(0, start - 1);
		const to = Math.min(length, end + lookahead + 1);
		const peaks = new Float32Array(to - from);
		const chunk = 256;
		for (let chunkStart = from; chunkStart < to; chunkStart += chunk) {
			const chunkEnd = Math.min(to, chunkStart + chunk);
			for (const data of channels) {
				const nearby = maxMagnitude({
					data,
					from: chunkStart - INTERPOLATION_HALF_TAPS,
					to: chunkEnd + INTERPOLATION_HALF_TAPS,
				});
				if (nearby * gain * INTERPOLATION_BOUND <= ceiling) continue;
				for (let index = chunkStart; index < chunkEnd; index++) {
					const peak =
						Math.max(Math.abs(data[index]), interpolatedPeak({ data, index })) *
						gain;
					if (peak > peaks[index - from]) peaks[index - from] = peak;
				}
			}
		}
		const needed = (index: number) => {
			const peak = Math.max(
				peaks[index - from],
				index - 1 >= from ? peaks[index - 1 - from] : 0,
			);
			return peak > ceiling ? ceiling / peak : 1;
		};
		if (start === 0) {
			// Before the first sample, the average already has to cover the
			// look-ahead's lowest need.
			let lowest = 1;
			for (let index = 0; index < Math.min(length, lookahead); index++)
				lowest = Math.min(lowest, needed(index));
			released.fill(lowest);
			releasedSum = lowest * lookahead;
			releasedDb = toDb(lowest);
		}
		const gains = new Float32Array(end - start);
		for (let index = start; index < end; index++) {
			// The window holds this sample and the look-ahead after it.
			for (; pushed < Math.min(length, index + lookahead); pushed++)
			{
				const gainNeeded = needed(pushed);
				while (tail > head && queueGain[(tail - 1) % size] >= gainNeeded) tail--;
				queueIndex[tail % size] = pushed;
				queueGain[tail % size] = gainNeeded;
				tail++;
			}
			while (queueIndex[head % size] < index) head++;
			const lowest = queueGain[head % size];
			releasedDb = Math.min(
				lowest >= 1 ? 0 : toDb(lowest),
				releasedDb + releasePerSample,
			);
			const slot = index % lookahead;
			const value = dbToLinear(releasedDb);
			releasedSum += value - released[slot];
			released[slot] = value;
			// Every average covers the sample that needs it, so none passes the ceiling.
			gains[index - start] = gain * Math.min(1, releasedSum / lookahead);
		}
		yield { start, end, gains };
		await pause();
	}
}

/** Applies `gainDb` and the true-peak ceiling to the mix, in place. */
export async function applyMixGain(options: {
	audio: MixAudio;
	gainDb: number;
	ceilingDbtp: number;
	signal?: AbortSignal;
}): Promise<void> {
	for await (const { start, end, gains } of mixGains(options)) {
		for (const data of options.audio.channels)
			for (let index = start; index < end; index++)
				data[index] *= gains[index - start];
	}
}

/** Measures the mix as `applyMixGain` would leave it, without changing it. */
async function measureWithGain(options: {
	audio: MixAudio;
	gainDb: number;
	ceilingDbtp: number;
	signal?: AbortSignal;
}): Promise<MixMeasurement> {
	const { channels, sampleRate } = options.audio;
	const meter = new MixMeter({ sampleRate, channelCount: channels.length });
	for await (const { start, end, gains } of mixGains(options)) {
		meter.add(
			channels.map((data) => {
				const slice = data.slice(start, end);
				for (let index = 0; index < slice.length; index++)
					slice[index] *= gains[index];
				return slice;
			}),
		);
	}
	return meter.finish();
}

/** Mix gains stay within what a sane mix could need. */
const MAX_MIX_GAIN_DB = 40;

/**
 * The gain that brings a mix to `targetLufs` under the ceiling. The ceiling
 * shaves the loudest moments, which lowers the loudness a little, so the
 * result is measured again with the gain and corrected once.
 */
export async function planMixGain({
	audio,
	targetLufs,
	ceilingDbtp,
	signal,
}: {
	audio: MixAudio;
	targetLufs: number;
	ceilingDbtp: number;
	signal?: AbortSignal;
}): Promise<{
	gainDb: number;
	measured: MixMeasurement;
	expected: MixMeasurement;
}> {
	const measured = await measureMix({ audio, signal });
	if (measured.integratedLufs === null)
		return { gainDb: 0, measured, expected: measured };
	const clamp = (value: number) =>
		Math.round(Math.max(-MAX_MIX_GAIN_DB, Math.min(MAX_MIX_GAIN_DB, value)) * 100) /
		100;
	let gainDb = clamp(targetLufs - measured.integratedLufs);
	let expected = await measureWithGain({ audio, gainDb, ceilingDbtp, signal });
	const shortfall =
		expected.integratedLufs === null ? 0 : targetLufs - expected.integratedLufs;
	if (Math.abs(shortfall) >= 0.1) {
		gainDb = clamp(gainDb + shortfall);
		expected = await measureWithGain({ audio, gainDb, ceilingDbtp, signal });
	}
	return { gainDb, measured, expected };
}
