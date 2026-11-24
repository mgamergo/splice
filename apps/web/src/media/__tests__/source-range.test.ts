import { describe, expect, test } from "bun:test";
import {
	createAudioRangeAssembler,
	DECODER_PREROLL_SECONDS,
	getClipSourceRange,
	getDecodeWindow,
} from "../source-range";

/** The slice of AudioBuffer the assembler reads; one value per sample, per channel. */
function chunk({
	channels,
	sampleRate = 10,
}: {
	channels: number[][];
	sampleRate?: number;
}) {
	const data = channels.map((values) => Float32Array.from(values));
	return {
		sampleRate,
		length: data[0].length,
		numberOfChannels: data.length,
		getChannelData: (channel: number) => data[channel],
	};
}

describe("getClipSourceRange", () => {
	test("covers the clip's in point through its duration, plus a short tail", () => {
		const range = getClipSourceRange({ trimStart: 600, duration: 15 });
		expect(range.start).toBe(600);
		expect(range.end).toBeCloseTo(615.05);
	});

	test("scales the source span by the clip's speed", () => {
		const range = getClipSourceRange({
			trimStart: 10,
			duration: 4,
			retime: { rate: 2 },
		});
		expect(range.start).toBe(10);
		expect(range.end).toBeCloseTo(18.05);
	});

	test("never starts before the source", () => {
		expect(getClipSourceRange({ trimStart: -1, duration: 2 }).start).toBe(0);
	});

	test("is empty, not reversed, when the clip ends before the source starts", () => {
		expect(getClipSourceRange({ trimStart: -1, duration: 0.25 })).toEqual({
			start: 0,
			end: 0,
		});
	});
});

describe("getDecodeWindow", () => {
	// AAC and Opus decode each packet from the state the packets before it
	// left, so a range decoded from its first packet starts with a glitch.
	test("starts the decoder's pre-roll before the range", () => {
		const window = getDecodeWindow({ range: { start: 600, end: 615 } });
		expect(DECODER_PREROLL_SECONDS).toBeGreaterThanOrEqual(0.08);
		expect(window.start).toBeCloseTo(600 - DECODER_PREROLL_SECONDS);
		expect(window.end).toBe(615);
	});

	test("never starts before the source", () => {
		expect(getDecodeWindow({ range: { start: 0.02, end: 1 } }).start).toBe(0);
	});
});

describe("createAudioRangeAssembler", () => {
	test("keeps exactly the range, dropping the decoder's lead-in and overshoot", () => {
		// 10 samples per second; the range is 1.2 s to 1.6 s (samples 12–15).
		const assembler = createAudioRangeAssembler({
			range: { start: 1.2, end: 1.6 },
			maxChannels: 2,
		});
		// The decoder starts at the packet before the range...
		assembler.add({
			timestamp: 1,
			buffer: chunk({ channels: [[10, 11, 12, 13, 14]] }),
		});
		// ...and its last packet runs past the end.
		assembler.add({
			timestamp: 1.5,
			buffer: chunk({ channels: [[15, 16, 17, 18, 19]] }),
		});
		const result = assembler.finish();
		expect(result?.sampleRate).toBe(10);
		expect(Array.from(result?.channels[0] ?? [])).toEqual([12, 13, 14, 15]);
		// A mono source stays one channel; the mix spreads it to both sides.
		expect(result?.channels).toHaveLength(1);
	});

	test("places chunks by timestamp, so a gap stays silent", () => {
		const assembler = createAudioRangeAssembler({
			range: { start: 0, end: 0.6 },
			maxChannels: 2,
		});
		assembler.add({ timestamp: 0, buffer: chunk({ channels: [[1, 2]] }) });
		assembler.add({ timestamp: 0.4, buffer: chunk({ channels: [[5, 6]] }) });
		expect(Array.from(assembler.finish()?.channels[0] ?? [])).toEqual([
			1, 2, 0, 0, 5, 6,
		]);
	});

	test("caps channels and ends where the source ends", () => {
		const assembler = createAudioRangeAssembler({
			range: { start: 0.1, end: 5 },
			maxChannels: 2,
		});
		assembler.add({
			timestamp: 0,
			buffer: chunk({
				channels: [
					[1, 2, 3],
					[4, 5, 6],
					[7, 8, 9],
				],
			}),
		});
		const result = assembler.finish();
		expect(result?.channels.map((data) => Array.from(data))).toEqual([
			[2, 3],
			[5, 6],
		]);
	});

	test("returns null when nothing lands in the range", () => {
		const assembler = createAudioRangeAssembler({
			range: { start: 30, end: 31 },
			maxChannels: 2,
		});
		expect(assembler.finish()).toBeNull();
		assembler.add({ timestamp: 0, buffer: chunk({ channels: [[1, 2, 3]] }) });
		expect(assembler.finish()).toBeNull();
	});
});
