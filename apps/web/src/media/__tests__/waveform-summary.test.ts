import { describe, expect, test } from "bun:test";
import { buildStreamedWaveformSummary } from "../waveform-summary";

/** The slice of AudioBuffer the summary reads. */
function chunk({
	values,
	sampleRate = 4,
}: {
	values: number[];
	sampleRate?: number;
}) {
	const data = Float32Array.from(values);
	const buffer: Pick<
		AudioBuffer,
		"sampleRate" | "length" | "numberOfChannels" | "getChannelData"
	> = {
		sampleRate,
		length: data.length,
		numberOfChannels: 1,
		getChannelData: () => data,
	};
	return buffer as AudioBuffer;
}

async function* chunks(items: Array<{ values: number[]; timestamp: number }>) {
	for (const { values, timestamp } of items) {
		yield { buffer: chunk({ values }), timestamp };
	}
}

describe("buildStreamedWaveformSummary", () => {
	test("keeps peaks on the source time axis across a delayed start and gaps", async () => {
		const summary = await buildStreamedWaveformSummary({
			sourceKey: "media:x",
			bucketSize: 4,
			// 4 samples per second: starts at 1 s, then a 1 s gap.
			chunks: chunks([
				{ values: [0.5, -0.5, 0.25, 0], timestamp: 1 },
				{ values: [1, 0, 0, -0.75], timestamp: 3 },
			]),
		});
		expect(Array.from(summary.amplitudes)).toEqual([0, 0.5, 0, 1]);
		expect(summary.totalSamples).toBe(16);
		expect(summary.sampleRate).toBe(4);
	});

	test("drops samples before source time zero", async () => {
		const summary = await buildStreamedWaveformSummary({
			sourceKey: "media:z",
			bucketSize: 2,
			// Starts 0.5 s (2 samples) before zero: the loud priming samples are cut.
			chunks: chunks([{ values: [1, 1, 0.25, 0.5], timestamp: -0.5 }]),
		});
		expect(Array.from(summary.amplitudes)).toEqual([0.5]);
		expect(summary.totalSamples).toBe(2);
	});

	test("matches the one-shot summary for contiguous audio", async () => {
		const summary = await buildStreamedWaveformSummary({
			sourceKey: "media:y",
			bucketSize: 3,
			chunks: chunks([
				{ values: [0.1, 0.2], timestamp: 0 },
				{ values: [0.9, 0.3, 0.4], timestamp: 0.5 },
			]),
		});
		expect(
			Array.from(summary.amplitudes).map((v) => Math.round(v * 10) / 10),
		).toEqual([0.9, 0.4]);
		expect(summary.totalSamples).toBe(5);
	});
});
