import { describe, expect, test } from "bun:test";
import {
	applyMixGain,
	type MixAudio,
	measureMix,
	planMixGain,
} from "../loudness-meter";

function sine({
	frequency,
	db,
	seconds,
	sampleRate = 48000,
	phase = 0,
}: {
	frequency: number;
	db: number;
	seconds: number;
	sampleRate?: number;
	phase?: number;
}): Float32Array {
	const amplitude = 10 ** (db / 20);
	const data = new Float32Array(Math.round(seconds * sampleRate));
	for (let index = 0; index < data.length; index++)
		data[index] =
			amplitude *
			Math.sin((2 * Math.PI * frequency * index) / sampleRate + phase);
	return data;
}

function concat(...parts: Float32Array[]): Float32Array {
	const joined = new Float32Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

const stereo = (data: Float32Array): MixAudio => ({
	channels: [data, data.slice()],
	sampleRate: 48000,
});

/** Speech-like: bursts of filtered noise with quiet gaps and a few sharp transients. */
function bursts({
	seconds,
	sampleRate = 44100,
}: {
	seconds: number;
	sampleRate?: number;
}) {
	let seed = 7;
	const random = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff - 0.5;
	};
	const data = new Float32Array(Math.round(seconds * sampleRate));
	let smooth = 0;
	for (let index = 0; index < data.length; index++) {
		smooth = 0.7 * smooth + 0.3 * random();
		const talking = Math.floor(index / (sampleRate * 0.8)) % 3 !== 2;
		data[index] = talking ? smooth * 0.2 : smooth * 0.002;
		if (index % (sampleRate * 2) === 100) data[index] = 0.9;
	}
	return { channels: [data, data.slice()], sampleRate };
}

describe("measureMix", () => {
	test("reads a stereo 1 kHz tone at -23 dBFS as -23 LUFS (EBU Tech 3341, case 1)", async () => {
		for (const sampleRate of [44100, 48000]) {
			const data = sine({ frequency: 1000, db: -23, seconds: 20, sampleRate });
			const { integratedLufs } = await measureMix({
				audio: { channels: [data, data.slice()], sampleRate },
			});
			expect(integratedLufs).not.toBeNull();
			expect(Math.abs((integratedLufs ?? 0) + 23)).toBeLessThan(0.1);
		}
	});

	test("gates out quiet passages (EBU Tech 3341, case 3)", async () => {
		const quiet = sine({ frequency: 1000, db: -36, seconds: 10 });
		const loud = sine({ frequency: 1000, db: -23, seconds: 60 });
		const { integratedLufs } = await measureMix({
			audio: stereo(concat(quiet, loud, quiet)),
		});
		expect(Math.abs((integratedLufs ?? 0) + 23)).toBeLessThan(0.1);
	});

	test("measures mono as dual mono, the way the editor plays it", async () => {
		const { integratedLufs } = await measureMix({
			audio: {
				channels: [sine({ frequency: 1000, db: -23, seconds: 10 })],
				sampleRate: 48000,
			},
		});
		expect(Math.abs((integratedLufs ?? 0) + 23)).toBeLessThan(0.1);
	});

	test("reports silence as unmeasurable", async () => {
		const measured = await measureMix({
			audio: stereo(new Float32Array(48000 * 2)),
		});
		expect(measured).toEqual({ integratedLufs: null, truePeakDbtp: null });
	});

	test("reads the true peak between samples, not just the sample peak", async () => {
		// A tone at a quarter of the rate, 45° off: every sample sits 3 dB under the crest.
		const data = sine({
			frequency: 12000,
			db: -6,
			seconds: 2,
			phase: Math.PI / 4,
		});
		const samplePeak = Math.max(
			...Array.from(data.subarray(0, 1000), Math.abs),
		);
		expect(20 * Math.log10(samplePeak)).toBeCloseTo(-9.03, 1);
		const { truePeakDbtp } = await measureMix({ audio: stereo(data) });
		expect(Math.abs((truePeakDbtp ?? 0) + 6)).toBeLessThan(0.3);
	});
});

describe("applyMixGain", () => {
	test("raises the mix by the gain and holds every true peak under the ceiling", async () => {
		const audio = bursts({ seconds: 12 });
		const quietIndex = Math.round(44100 * 1.9);
		const before = audio.channels[0][quietIndex];
		await applyMixGain({ audio, gainDb: 12, ceilingDbtp: -1 });
		const { truePeakDbtp } = await measureMix({ audio });
		expect(truePeakDbtp ?? 0).toBeLessThanOrEqual(-1);
		// Away from the transients, the gain applies as it is.
		expect(audio.channels[0][quietIndex]).toBeCloseTo(
			before * 10 ** (12 / 20),
			5,
		);
	});

	test("leaves a mix under the ceiling exactly as the gain sets it", async () => {
		const data = sine({ frequency: 440, db: -20, seconds: 1 });
		const audio = stereo(data.slice());
		await applyMixGain({ audio, gainDb: -6, ceilingDbtp: -1 });
		for (let index = 0; index < data.length; index += 997)
			expect(audio.channels[0][index]).toBeCloseTo(
				data[index] * 10 ** (-6 / 20),
				6,
			);
	});
});

describe("planMixGain", () => {
	test("brings a mix to -14 LUFS with its true peak at or under -1 dBTP", async () => {
		const audio = bursts({ seconds: 20 });
		const original = audio.channels[0].slice();
		const plan = await planMixGain({ audio, targetLufs: -14, ceilingDbtp: -1 });
		// Planning leaves the mix alone.
		expect(audio.channels[0]).toEqual(original);
		await applyMixGain({ audio, gainDb: plan.gainDb, ceilingDbtp: -1 });
		const after = await measureMix({ audio });
		expect(Math.abs((after.integratedLufs ?? 0) + 14)).toBeLessThan(0.2);
		expect(after.truePeakDbtp ?? 0).toBeLessThanOrEqual(-1);
		expect(after.integratedLufs).toBeCloseTo(
			plan.expected.integratedLufs ?? 0,
			1,
		);
	});

	test("keeps silence at unity", async () => {
		const plan = await planMixGain({
			audio: stereo(new Float32Array(48000)),
			targetLufs: -14,
			ceilingDbtp: -1,
		});
		expect(plan.gainDb).toBe(0);
	});
});
