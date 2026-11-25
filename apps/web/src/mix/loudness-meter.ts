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
		b: [
			(vh + (vb * k) / q + k * k) / a0,
			(2 * (k * k - vh)) / a0,
			(vh - (vb * k) / q + k * k) / a0,
		],
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
// Order-48, four-phase FIR from ITU-R BS.1770-4, Annex 2 (also in BS.1770-5).
const PHASE_0 = [
	0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125,
	-0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875,
	0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125,
];
const PHASE_1 = [
	-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625,
	0.465087890625, 0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625,
	0.0330810546875, -0.0189208984375,
];
const INTERPOLATION_PHASES = [
	PHASE_0,
	PHASE_1,
	[...PHASE_1].reverse(),
	[...PHASE_0].reverse(),
];
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
	for (
		let index = Math.max(0, from);
		index < Math.min(data.length, to);
		index++
	) {
		const magnitude = Math.abs(data[index]);
		if (magnitude > peak) peak = magnitude;
	}
	return peak;
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Points either side of a sample whose 4× oversampled peak can be read. */
const HISTORY = 2 * INTERPOLATION_HALF_TAPS - 1;

/**
 * Measures loudness and true peak of audio fed to it a slice at a time, so a
 * long mix is measured without holding a second copy of it.
 */
export class MixMeter {
	private readonly filters: ReturnType<typeof kWeighting>;
	private readonly state: Array<
		Array<{ x1: number; x2: number; y1: number; y2: number }>
	>;
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
						b[0] * value +
						b[1] * s.x1 +
						b[2] * s.x2 -
						a[0] * s.y1 -
						a[1] * s.y2;
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
				from: INTERPOLATION_HALF_TAPS - 1,
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
			() => new Float32Array(HISTORY),
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

// The envelope is aligned to the sequence sample grid. Each knot sees both
// adjacent intervals, and recovers to unity in a finite number of intervals.
const CONTROL_SECONDS = 0.005;
const RELEASE_INTERVALS = 50;
const CEILING_MARGIN_DB = 0.35;

export type SampleRange = { start: number; end: number };
export type ReadMixSamples = (range: SampleRange) => Promise<Float32Array[]>;

function controlLength(sampleRate: number): number {
	return Math.max(1, Math.round(CONTROL_SECONDS * sampleRate));
}

/** The unmastered samples needed to render any output span independently. */
export function limiterInputRange({
	start,
	end,
	sampleRate,
	length,
}: SampleRange & { sampleRate: number; length: number }): SampleRange {
	const step = controlLength(sampleRate);
	return {
		start: Math.max(
			0,
			(Math.floor(start / step) - RELEASE_INTERVALS - 1) * step - 2 * HISTORY,
		),
		end: Math.min(length, (Math.ceil(end / step) + 1) * step + 2 * HISTORY),
	};
}

function limitRange({
	input,
	inputStart,
	start,
	end,
	sampleRate,
	gainDb,
	ceilingDbtp,
}: SampleRange & {
	input: Float32Array[];
	inputStart: number;
	sampleRate: number;
	gainDb: number;
	ceilingDbtp: number;
}): Float32Array[] {
	const step = controlLength(sampleRate);
	const gain = dbToLinear(gainDb);
	const ceiling = dbToLinear(ceilingDbtp - CEILING_MARGIN_DB);
	const first = Math.floor(start / step);
	const last = Math.ceil(end / step);
	const firstInterval = first - RELEASE_INTERVALS - 1;
	const caps = new Float64Array(last - firstInterval + 1);
	for (let interval = firstInterval; interval <= last; interval++) {
		// Include nearby FIR points so smoothing cannot lift a sample that
		// contributes to a peak just across a control interval boundary.
		const from = interval * step - inputStart - INTERPOLATION_HALF_TAPS;
		const to = (interval + 1) * step - inputStart + INTERPOLATION_HALF_TAPS;
		let peak = ceiling / gain;
		for (const data of input) {
			const samplePeak = maxMagnitude({ data, from, to });
			peak = truePeakBetween({
				data,
				from,
				to,
				floor: Math.max(peak, samplePeak),
			});
		}
		caps[interval - firstInterval] = Math.min(1, ceiling / (peak * gain));
	}
	const knots = new Float64Array(last - first + 1);
	for (let knot = first; knot <= last; knot++) {
		let cap = 1;
		for (let age = 0; age < RELEASE_INTERVALS; age++) {
			const index = knot - age - firstInterval;
			const minimum = Math.min(caps[index - 1], caps[index]);
			cap = Math.min(cap, minimum + ((1 - minimum) * age) / RELEASE_INTERVALS);
		}
		knots[knot - first] = cap * gain;
	}
	return input.map((data) => {
		const output = new Float32Array(end - start);
		for (let index = start; index < end; index++) {
			const knot = Math.floor(index / step) - first;
			const fraction = (index % step) / step;
			const scale = knots[knot] + (knots[knot + 1] - knots[knot]) * fraction;
			output[index - start] = data[index - inputStart] * scale;
		}
		return output;
	});
}

/** Render the same master at any playhead, with bounded past and future input. */
export async function readMasteredSamples({
	read,
	start,
	end,
	length,
	sampleRate,
	gainDb,
	ceilingDbtp,
}: SampleRange & {
	read: ReadMixSamples;
	length: number;
	sampleRate: number;
	gainDb: number;
	ceilingDbtp: number;
}): Promise<Float32Array[]> {
	const range = limiterInputRange({ start, end, length, sampleRate });
	const input = await read(range);
	return limitRange({
		input,
		inputStart: range.start,
		start,
		end,
		sampleRate,
		gainDb,
		ceilingDbtp,
	});
}

/** Applies the same master as preview and export, in place. */
export async function applyMixGain({
	audio,
	gainDb,
	ceilingDbtp,
	signal,
}: {
	audio: MixAudio;
	gainDb: number;
	ceilingDbtp: number;
	signal?: AbortSignal;
}): Promise<void> {
	const { channels, sampleRate } = audio;
	const length = channels[0]?.length ?? 0;
	let previous: { start: number; channels: Float32Array[] } | undefined;
	for (const { start, end } of slices({ length })) {
		signal?.throwIfAborted();
		const output = await readMasteredSamples({
			read: async (range) =>
				channels.map((data) => data.subarray(range.start, range.end)),
			start,
			end,
			length,
			sampleRate,
			gainDb,
			ceilingDbtp,
		});
		// The next block needs the dry tail of this block.
		if (previous) {
			const ready = previous;
			channels.forEach((data, channel) =>
				data.set(ready.channels[channel], ready.start),
			);
		}
		previous = { start, channels: output };
		await pause();
	}
	if (previous) {
		const ready = previous;
		channels.forEach((data, channel) =>
			data.set(ready.channels[channel], ready.start),
		);
	}
	signal?.throwIfAborted();
}

export async function measureMixBlocks({
	read,
	length,
	sampleRate,
	channelCount,
	master,
	signal,
}: {
	read: ReadMixSamples;
	length: number;
	sampleRate: number;
	channelCount: number;
	master?: { gainDb: number; ceilingDbtp: number };
	signal?: AbortSignal;
}): Promise<MixMeasurement> {
	const meter = new MixMeter({ sampleRate, channelCount });
	for (const range of slices({ length })) {
		signal?.throwIfAborted();
		meter.add(
			master
				? await readMasteredSamples({
						...range,
						read,
						length,
						sampleRate,
						...master,
					})
				: await read(range),
		);
		await pause();
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
	signal,
	...options
}: {
	audio: MixAudio;
	targetLufs: number;
	ceilingDbtp: number;
	signal?: AbortSignal;
}) {
	return planMixGainFromBlocks({
		...options,
		signal,
		sampleRate: audio.sampleRate,
		channelCount: audio.channels.length,
		length: audio.channels[0]?.length ?? 0,
		read: async ({ start, end }) =>
			audio.channels.map((data) => data.subarray(start, end)),
	});
}

export async function planMixGainFromBlocks({
	targetLufs,
	ceilingDbtp,
	...input
}: Omit<Parameters<typeof measureMixBlocks>[0], "master"> & {
	targetLufs: number;
	ceilingDbtp: number;
}): Promise<{
	gainDb: number;
	measured: MixMeasurement;
	expected: MixMeasurement;
}> {
	const measured = await measureMixBlocks(input);
	if (measured.integratedLufs === null)
		return { gainDb: 0, measured, expected: measured };
	const clamp = (value: number) =>
		Math.round(
			Math.max(-MAX_MIX_GAIN_DB, Math.min(MAX_MIX_GAIN_DB, value)) * 100,
		) / 100;
	let gainDb = clamp(targetLufs - measured.integratedLufs);
	let expected = await measureMixBlocks({
		...input,
		master: { gainDb, ceilingDbtp },
	});
	const shortfall =
		expected.integratedLufs === null ? 0 : targetLufs - expected.integratedLufs;
	if (Math.abs(shortfall) >= 0.1) {
		gainDb = clamp(gainDb + shortfall);
		expected = await measureMixBlocks({
			...input,
			master: { gainDb, ceilingDbtp },
		});
	}
	return { gainDb, measured, expected };
}
