import { describe, expect, test } from "bun:test";
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny";
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

	test("stays empty when the clip ends within the tail of the source's start", () => {
		expect(getClipSourceRange({ trimStart: -1, duration: 0.99 })).toEqual({
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
			timeResolution: 10,
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
			timeResolution: 10,
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
			timeResolution: 10,
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
			timeResolution: 10,
		});
		expect(assembler.finish()).toBeNull();
		assembler.add({ timestamp: 0, buffer: chunk({ channels: [[1, 2, 3]] }) });
		expect(assembler.finish()).toBeNull();
	});
});

/** A decoded chunk whose samples are their own index in the stream, so any gap or overlap shows. */
function indexedChunk({
	first,
	length,
	sampleRate,
}: {
	first: number;
	length: number;
	sampleRate: number;
}) {
	return chunk({
		channels: [Array.from({ length }, (_, index) => first + index)],
		sampleRate,
	});
}

/** Indices of the samples that don't follow the one before them. */
function discontinuities(samples: Float32Array): number[] {
	const breaks: number[] = [];
	for (let index = 1; index < samples.length; index++) {
		if (samples[index] !== samples[index - 1] + 1) breaks.push(index);
	}
	return breaks;
}

describe("createAudioRangeAssembler with container timestamps", () => {
	const AAC_FRAME = 1024;
	const SAMPLE_RATE = 48000;

	test("joins continuous chunks whose timestamps are rounded to milliseconds", () => {
		// 1024-sample AAC frames at 48 kHz last 21.33 ms; Matroska stores 0, 21, 43, 64…
		const assembler = createAudioRangeAssembler({
			range: { start: 0, end: 1 },
			maxChannels: 2,
			timeResolution: 1000,
		});
		for (let frame = 0; frame * AAC_FRAME < SAMPLE_RATE + AAC_FRAME; frame++) {
			const first = frame * AAC_FRAME;
			assembler.add({
				timestamp: Math.round((first / SAMPLE_RATE) * 1000) / 1000,
				buffer: indexedChunk({
					first,
					length: AAC_FRAME,
					sampleRate: SAMPLE_RATE,
				}),
			});
		}
		const samples = assembler.finish()?.channels[0] ?? new Float32Array();
		expect(samples).toHaveLength(SAMPLE_RATE);
		expect(samples[0]).toBe(0);
		expect(discontinuities(samples)).toEqual([]);
	});

	test("still leaves a real gap silent at 48 kHz", () => {
		const assembler = createAudioRangeAssembler({
			range: { start: 0, end: 0.1 },
			maxChannels: 2,
			timeResolution: 1000,
		});
		assembler.add({
			timestamp: 0,
			buffer: indexedChunk({ first: 1, length: 960, sampleRate: SAMPLE_RATE }),
		});
		// 20 ms of the source are missing before the next chunk.
		assembler.add({
			timestamp: 0.04,
			buffer: indexedChunk({ first: 1, length: 960, sampleRate: SAMPLE_RATE }),
		});
		const samples = assembler.finish()?.channels[0] ?? new Float32Array();
		expect(Array.from(samples.subarray(960, 1920)).every((v) => v === 0)).toBe(
			true,
		);
		expect(samples[1920]).toBe(1);
	});

	test("keeps short gaps in a track with sample-accurate timestamps", () => {
		// MP4 stores AAC timestamps in samples: these gaps are real, not rounding.
		const GAP = 72;
		const assembler = createAudioRangeAssembler({
			range: { start: 0, end: (4 * AAC_FRAME + 2 * GAP) / SAMPLE_RATE },
			maxChannels: 2,
			timeResolution: SAMPLE_RATE,
		});
		const starts = [
			0,
			AAC_FRAME + GAP,
			2 * AAC_FRAME + GAP,
			3 * AAC_FRAME + 2 * GAP,
		];
		for (const [index, start] of starts.entries()) {
			assembler.add({
				timestamp: start / SAMPLE_RATE,
				buffer: indexedChunk({
					first: index * AAC_FRAME,
					length: AAC_FRAME,
					sampleRate: SAMPLE_RATE,
				}),
			});
		}
		const samples = assembler.finish()?.channels[0] ?? new Float32Array();
		expect(samples).toHaveLength(4 * AAC_FRAME + 2 * GAP);
		// Each chunk starts exactly where its timestamp says...
		for (const [index, start] of starts.entries()) {
			expect(samples[start]).toBe(index * AAC_FRAME);
		}
		// ...and each gap is silent for exactly its own length.
		for (const start of [AAC_FRAME, 3 * AAC_FRAME + GAP]) {
			expect(Array.from(samples.subarray(start, start + GAP))).toEqual(
				new Array<number>(GAP).fill(0),
			);
		}
	});

	test("assembles a 48 kHz AAC tone in Matroska without gaps or overlaps", async () => {
		// One second of a sine, encoded by FFmpeg:
		// ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 -c:a aac -b:a 24k -ac 1 tone-48k-aac.mkv
		const bytes = await Bun.file(
			new URL("./fixtures/tone-48k-aac.mkv", import.meta.url),
		).arrayBuffer();
		const input = new Input({
			source: new BlobSource(new Blob([bytes])),
			formats: ALL_FORMATS,
		});
		try {
			const track = await input.getPrimaryAudioTrack();
			if (!track) throw new Error("The fixture has no audio track");
			expect(track.sampleRate).toBe(SAMPLE_RATE);

			const range = { start: 0.25, end: 0.75 };
			// Matroska's millisecond timestamps.
			expect(track.timeResolution).toBe(1000);
			const assembler = createAudioRangeAssembler({
				range,
				maxChannels: 2,
				timeResolution: track.timeResolution,
			});
			// Each AAC packet decodes to the next 1024 samples of the stream; the
			// container's timestamps say where they go.
			let first = 0;
			const timestamps: number[] = [];
			for await (const packet of new EncodedPacketSink(track).packets()) {
				timestamps.push(packet.timestamp);
				assembler.add({
					timestamp: packet.timestamp,
					buffer: indexedChunk({
						first,
						length: AAC_FRAME,
						sampleRate: SAMPLE_RATE,
					}),
				});
				first += AAC_FRAME;
			}
			// The timestamps really are rounded, or this test proves nothing.
			const offFrame = timestamps.filter((timestamp) => {
				const sample = timestamp * SAMPLE_RATE;
				return Math.abs(sample - Math.round(sample / AAC_FRAME) * AAC_FRAME) > 1;
			});
			expect(offFrame.length).toBeGreaterThan(timestamps.length / 2);

			const samples = assembler.finish()?.channels[0] ?? new Float32Array();
			expect(samples).toHaveLength((range.end - range.start) * SAMPLE_RATE);
			expect(discontinuities(samples)).toEqual([]);
		} finally {
			input.dispose();
		}
	});
});
