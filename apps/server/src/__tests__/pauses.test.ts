import { expect, test } from "bun:test";
import type { RoughCutSources, Transcript } from "@splice/bridge";
import { roughCutTabRequestSchema } from "@splice/bridge/ops";
import {
	chmod,
	mkdir,
	mkdtemp,
	rename,
	rm,
	stat,
	utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	combineSilencesWithTranscript,
	createPauseDetector,
	fillerCut,
	findFillerWords,
	lastsAtLeast,
	parseSilencedetect,
	silencedetectArgs,
} from "../pauses";
import { footageVersion } from "../footage";
import { resolveRoughCutRequest } from "../rough-cut";
import { extractAudio, parseHasAudio } from "../transcription-tools";

// Captured from FFmpeg 6.1 on a generated recording; one silence is still open at the end.
const silencedetectOutput = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'rec-01.mp4':
  Duration: 00:00:48.20, start: 0.000000, bitrate: 1191 kb/s
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 96 kb/s (default)
Stream mapping:
  Stream #0:1 -> #0:0 (aac (native) -> pcm_s16le (native))
[silencedetect @ 0x55d0c1f2a580] silence_start: -0.00266667
[silencedetect @ 0x55d0c1f2a580] silence_end: 1.0063 | silence_duration: 1.00897
[silencedetect @ 0x55d0c1f2a580] silence_start: 6.3858
[silencedetect @ 0x55d0c1f2a580] silence_end: 8.89126 | silence_duration: 2.50546
[silencedetect @ 0x55d0c1f2a580] silence_start: 46.6012
[out#0/null @ 0x55d0c1f29e40] video:0KiB audio:4519KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:00:48.20 bitrate=N/A speed= 412x`;

// Captured from FFmpeg 8.1, which logs events under the filter instance's name.
const silencedetectOutput8 = `Input #0, wav, from 'gen.wav':
  Duration: 00:00:04.50, bitrate: 705 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, mono, s16, 705 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_s16le (native))
[Parsed_silencedetect_1 @ 0x7f6354012e80] silence_start: 1.999955
[Parsed_silencedetect_1 @ 0x7f6354012e80] silence_end: 3.500068 | silence_duration: 1.500113
[out#0/null @ 0x55d4a150b840] video:0KiB audio:388KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:00:04.50 bitrate=N/A speed=2.2e+03x elapsed=0:00:00.00`;

const word = ([text, start, end]: [string, number, number]) => ({
	text,
	start,
	end,
	probability: 0.9,
});

function transcript({
	words,
	language = "en",
}: {
	words: ReturnType<typeof word>[];
	language?: string;
}): Transcript {
	return {
		path: "rec.mp4",
		durationSeconds: 60,
		language,
		model: "base.en",
		segments: [{ start: 0, end: 60, text: "", words }],
	};
}

test("parses silencedetect output, clamping negative starts and closing a silence at the end", () => {
	expect(parseSilencedetect({ output: silencedetectOutput })).toEqual({
		durationSeconds: 48.2,
		silences: [
			{ start: 0, end: 1.0063 },
			{ start: 6.3858, end: 8.89126 },
			{ start: 46.6012, end: 48.2 },
		],
	});
	expect(parseSilencedetect({ output: silencedetectOutput8 })).toEqual({
		durationSeconds: 4.5,
		silences: [{ start: 1.999955, end: 3.500068 }],
	});
	expect(
		parseSilencedetect({
			output:
				"[Parsed_silenceremove_0 @ 0x1] silence_start: 1\n[Parsed_silenceremove_0 @ 0x1] silence_end: 2",
		}).silences,
	).toEqual([]);
	expect(parseSilencedetect({ output: "garbage\nsilence_end: 3" })).toEqual({
		durationSeconds: null,
		silences: [],
	});
	expect(silencedetectArgs({ source: "a b.mp4", noiseDb: -40 })).toEqual([
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"info",
		"-nostats",
		"-protocol_whitelist",
		"file",
		"-format_whitelist",
		"mov,matroska,webm,wav,mp3,aac,flac,ogg",
		"-i",
		"a b.mp4",
		"-map",
		"0:a:0",
		"-af",
		"aresample=async=1:first_pts=0,silencedetect=noise=-40dB:duration=0.1",
		"-f",
		"null",
		"-",
	]);
});

test("joins silences around a click only when the transcript has no word there", () => {
	const silences = [
		{ start: 1, end: 1.4 },
		{ start: 1.5, end: 2 },
		{ start: 5, end: 5.3 },
		{ start: 5.4, end: 5.8 },
		{ start: 9, end: 9.5 },
	];
	expect(
		combineSilencesWithTranscript({
			silences,
			words: [word(["a", 5.31, 5.39])],
			minSeconds: 0.6,
		}),
	).toEqual([{ start: 1, end: 2 }]);
	// Without a transcript nothing tells a click from a short word.
	expect(
		combineSilencesWithTranscript({ silences, words: null, minSeconds: 0.35 }),
	).toEqual([
		{ start: 1, end: 1.4 },
		{ start: 1.5, end: 2 },
		{ start: 5.4, end: 5.8 },
		{ start: 9, end: 9.5 },
	]);
	// Whisper's drifting words never move or split an audio silence.
	expect(
		combineSilencesWithTranscript({
			silences: [{ start: 6.4, end: 9.5 }],
			words: [word(["Welcome", 9, 9]), word(["Editing", 9, 9.15])],
			minSeconds: 0.6,
		}),
	).toEqual([{ start: 6.4, end: 9.5 }]);
});

test("keeps a short word Whisper timed inside the silence after it", () => {
	// "a" sounds at 1.50–1.60 s, but Whisper puts it in the next silence.
	const silences = [
		{ start: 1, end: 1.5 },
		{ start: 1.6, end: 2.2 },
	];
	const words = [
		word(["Take", 0.2, 0.9]),
		word(["a", 1.65, 1.72]),
		word(["breath", 2.3, 2.8]),
	];
	expect(
		combineSilencesWithTranscript({ silences, words, minSeconds: 0.5 }),
	).toEqual(silences);
	// Drifted from the speech after the second silence, the word is nearer that
	// speech than the click, so the silences still join.
	expect(
		combineSilencesWithTranscript({
			silences,
			words: [word(["Take", 0.2, 0.9]), word(["breath", 2.05, 2.8])],
			minSeconds: 0.5,
		}),
	).toEqual([{ start: 1, end: 2.2 }]);
});

test("moves filler words from Whisper's times to their sound between two silences", () => {
	// Captured drift: Whisper put "erm" inside the silence before the real filler.
	const silences = [
		{ start: 26, end: 27.2 },
		{ start: 27.8, end: 28.64 },
		{ start: 29, end: 29.9 },
		{ start: 31.7, end: 35 },
	];
	const words = [
		word(["Then", 27, 27.2]),
		word(["we", 27.23, 27.38]),
		word(["Erm,", 28.07, 28.29]),
		word(["check", 29.95, 30.6]),
		word(["umbrella", 33, 33.5]),
		word(["uh.", 40, 40.3]),
	];
	const fillers = findFillerWords({
		transcript: transcript({ words }),
		silences,
	});
	expect(fillers).toEqual([
		{
			start: 28.64,
			end: 29,
			text: "Erm,",
			aligned: true,
			silenceBefore: silences[1],
			silenceAfter: silences[2],
		},
		{ start: 40, end: 40.3, text: "uh.", aligned: false },
	]);
	expect(fillerCut({ filler: fillers[0], paddingSeconds: 0.2 })).toEqual({
		start: 28,
		end: 29.7,
	});
	// A silence shorter than the padding is kept whole.
	expect(
		fillerCut({
			filler: { ...fillers[0], silenceBefore: { start: 28.55, end: 28.64 } },
			paddingSeconds: 0.2,
		}),
	).toEqual({ start: 28.64, end: 29.7 });
	expect(fillerCut({ filler: fillers[1], paddingSeconds: 0.2 })).toBeNull();
	expect(
		findFillerWords({
			transcript: transcript({ words, language: "de" }),
			silences,
		}),
	).toEqual([]);
	// When "check" drifts into the silence and touches that sound, it is as
	// likely the word's sound as the filler's, so nothing is cut.
	expect(
		findFillerWords({
			transcript: transcript({
				words: words.map((each) =>
					each.text === "check" ? word(["check", 29, 29.79]) : each,
				),
			}),
			silences,
		})[0],
	).toEqual({ start: 28.07, end: 28.29, text: "Erm,", aligned: false });
});

test("never cuts a sound a real word's times barely miss", () => {
	// Heard: "um" at 0–0.22 s and "go" at 0.50–0.75 s. Whisper puts "um" at
	// 0.23–0.49 and starts "go" 10 ms after its sound ends.
	const silences = [
		{ start: 0.22, end: 0.5 },
		{ start: 0.75, end: 1.2 },
	];
	const [um] = findFillerWords({
		transcript: transcript({
			words: [
				word(["um", 0.23, 0.49]),
				word(["go", 0.76, 1.05]),
				word(["next", 1.22, 1.5]),
			],
		}),
		silences,
	});
	expect(um).toEqual({ start: 0.23, end: 0.49, text: "um", aligned: false });
	expect(fillerCut({ filler: um, paddingSeconds: 0.2 })).toBeNull();
	// A filler whose times reach 5 ms into the sound doesn't outweigh a word
	// 10 ms from it.
	const [reaching] = findFillerWords({
		transcript: transcript({
			words: [
				word(["um", 0.23, 0.505]),
				word(["go", 0.76, 1.05]),
				word(["next", 1.22, 1.5]),
			],
		}),
		silences,
	});
	expect(reaching).toEqual({
		start: 0.23,
		end: 0.505,
		text: "um",
		aligned: false,
	});
	expect(fillerCut({ filler: reaching, paddingSeconds: 0.2 })).toBeNull();
	// A word closer to the sound than the filler claims it too.
	expect(
		findFillerWords({
			transcript: transcript({
				words: [word(["um", 0.1, 0.4]), word(["go", 0.8, 1.05])],
			}),
			silences,
		})[0].aligned,
	).toBe(false);
});

test("aligns each of two isolated fillers whose times touch both sounds", () => {
	// Heard: "uh" at 2.00–2.30 s and "um" at 2.45–2.80 s. Whisper's "um" starts
	// 10 ms inside the sound of "uh".
	const silences = [
		{ start: 1.4, end: 2 },
		{ start: 2.3, end: 2.45 },
		{ start: 2.8, end: 3.4 },
	];
	const fillers = findFillerWords({
		transcript: transcript({
			words: [
				word(["uh", 1.94, 2.29]),
				word(["um", 2.29, 2.7]),
				word(["next", 3.42, 3.72]),
			],
		}),
		silences,
	});
	expect(
		fillers.map(({ start, end, aligned }) => [start, end, aligned]),
	).toEqual([
		[2, 2.3, true],
		[2.45, 2.8, true],
	]);
});

test("cuts back-to-back fillers heard as one sound between two silences", () => {
	// Heard: "I say" at 0.2–0.9 s, then "uh uh uh" at 1.4–2.6 s with no silence
	// between the fillers, so none of them is a short sound on its own.
	const silences = [
		{ start: 0, end: 0.2 },
		{ start: 0.9, end: 1.4 },
		{ start: 2.6, end: 3.2 },
		{ start: 3.6, end: 4.2 },
	];
	const before = [word(["I", 0.25, 0.4]), word(["say", 0.45, 0.85])];
	const stutter = [
		word(["uh", 1.4, 1.7]),
		word(["uh", 1.75, 2.1]),
		word(["uh", 2.15, 2.55]),
	];
	const fillers = findFillerWords({
		transcript: transcript({
			words: [...before, ...stutter, word(["then", 3.25, 3.55])],
		}),
		silences,
	});
	expect(fillers).toEqual([
		{
			start: 1.4,
			end: 2.6,
			text: "uh uh uh",
			aligned: true,
			silenceBefore: silences[1],
			silenceAfter: silences[2],
		},
	]);
	expect(fillerCut({ filler: fillers[0], paddingSeconds: 0.2 })).toEqual({
		start: 1.1,
		end: 3,
	});
	// A real word heard in the same sound keeps the whole run.
	expect(
		findFillerWords({
			transcript: transcript({
				words: [
					...before,
					word(["uh", 1.4, 1.7]),
					word(["uh", 1.75, 2.1]),
					word(["go", 2.2, 2.58]),
					word(["then", 3.25, 3.55]),
				],
			}),
			silences,
		}).map(({ aligned }) => aligned),
	).toEqual([false, false]);
});

test("leaves a filler in place when its sound could be a real word", () => {
	// "um" sits inside continuous speech; the next isolated sound is "go",
	// whose transcript time drifted past it.
	const silences = [
		{ start: 0, end: 1 },
		{ start: 3, end: 3.12 },
		{ start: 3.4, end: 4 },
	];
	expect(
		findFillerWords({
			transcript: transcript({
				words: [
					word(["We", 1.2, 1.6]),
					word(["um", 2.3, 2.6]),
					word(["go", 3.45, 3.75]),
				],
			}),
			silences,
		}),
	).toEqual([{ start: 2.3, end: 2.6, text: "um", aligned: false }]);
	// Heard in a silence, but a real word's times overlap the only short sound.
	expect(
		findFillerWords({
			transcript: transcript({
				words: [word(["uh", 3.02, 3.1]), word(["go", 3.3, 3.6])],
			}),
			silences,
		}),
	).toEqual([{ start: 3.02, end: 3.1, text: "uh", aligned: false }]);
	// The same sound with no word on it is the filler.
	expect(
		findFillerWords({
			transcript: transcript({
				words: [word(["uh", 3.02, 3.1]), word(["go", 4.2, 4.5])],
			}),
			silences,
		}),
	).toEqual([
		{
			start: 3.12,
			end: 3.4,
			text: "uh",
			aligned: true,
			silenceBefore: silences[1],
			silenceAfter: silences[2],
		},
	]);
});

test("aligns a filler whose neighbors' drifted times only brush its sound", () => {
	// Timings from whisper.cpp on the end-to-end fixture. "check" overlaps the
	// filler's sound by 7 ms, and "lesson." runs most of the way through it
	// while lying mostly in its own sound.
	const erm = [
		{ start: 27.7973, end: 28.6411 },
		{ start: 29.0068, end: 29.905 },
	];
	expect(
		findFillerWords({
			transcript: transcript({
				words: [
					word(["we...", 27.23, 28.07]),
					word(["erm...", 28.07, 28.99]),
					word(["check", 29, 29.79]),
				],
			}),
			silences: erm,
		}),
	).toEqual([
		{
			start: 28.6411,
			end: 29.0068,
			text: "erm...",
			aligned: true,
			silenceBefore: erm[0],
			silenceAfter: erm[1],
		},
	]);
	const uh = [
		{ start: 2.90871, end: 3.79908 },
		{ start: 4.06817, end: 4.962 },
	];
	expect(
		findFillerWords({
			transcript: transcript({
				words: [
					word(["the", 2.31, 2.62]),
					word(["lesson.", 2.62, 4.01]),
					word(["uh,", 4.01, 5]),
					word(["we", 5, 5.21]),
				],
			}),
			silences: uh,
		}),
	).toEqual([
		{
			start: 3.79908,
			end: 4.06817,
			text: "uh,",
			aligned: true,
			silenceBefore: uh[0],
			silenceAfter: uh[1],
		},
	]);
});

test("measures pause length in whole milliseconds, wherever the pause sits", () => {
	expect(8.6 - 8).toBeLessThan(0.6);
	expect(lastsAtLeast({ range: { start: 8, end: 8.6 }, seconds: 0.6 })).toBe(
		true,
	);
	expect(lastsAtLeast({ range: { start: 8, end: 8.599 }, seconds: 0.6 })).toBe(
		false,
	);
	expect(
		combineSilencesWithTranscript({
			silences: [
				{ start: 1, end: 1.6 },
				{ start: 8, end: 8.6 },
			],
			words: null,
			minSeconds: 0.6,
		}),
	).toEqual([
		{ start: 1, end: 1.6 },
		{ start: 8, end: 8.6 },
	]);
});

test("reads whether FFmpeg lists an audio stream in the input", () => {
	expect(parseHasAudio({ output: silencedetectOutput })).toBe(true);
	expect(
		parseHasAudio({
			output: `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'screen.mp4':
  Duration: 00:00:01.00, start: 0.000000, bitrate: 18 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 128x72, 25 fps (default)
Output #0, ffmetadata, to 'pipe:':
  Stream #0:0: Audio: pcm_s16le`,
		}),
	).toBe(false);
});

function silentWav({ seconds }: { seconds: Array<[number, boolean]> }) {
	const rate = 8000;
	const samples = seconds.flatMap(([length, loud]) =>
		Array.from({ length: Math.round(length * rate) }, (_, i) =>
			loud ? Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000) : 0,
		),
	);
	const data = Buffer.alloc(44 + samples.length * 2);
	data.write("RIFF", 0);
	data.writeUInt32LE(36 + samples.length * 2, 4);
	data.write("WAVEfmt ", 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(1, 20);
	data.writeUInt16LE(1, 22);
	data.writeUInt32LE(rate, 24);
	data.writeUInt32LE(rate * 2, 28);
	data.writeUInt16LE(2, 32);
	data.writeUInt16LE(16, 34);
	data.write("data", 36);
	data.writeUInt32LE(samples.length * 2, 40);
	samples.forEach((sample, i) => data.writeInt16LE(sample, 44 + i * 2));
	return data;
}

test.skipIf(!Bun.which("ffmpeg"))(
	"detects pauses with FFmpeg, caches the scan and adds fillers from the transcript",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-pauses-"));
		try {
			await mkdir(join(root, "Footage"));
			await Bun.write(
				join(root, "Footage", "take.wav"),
				silentWav({
					seconds: [
						[1, true],
						[1.5, false],
						[0.6, true],
						[0.3, false],
						[1, true],
						[0.8, false],
					],
				}),
			);
			let cached: Transcript | null = null;
			const detector = createPauseDetector({
				root,
				readTranscript: async () => cached,
			});
			const first = await detector.detect({ params: { path: "take.wav" } });
			expect(first).toMatchObject({
				path: "take.wav",
				noiseDb: -35,
				minSeconds: 0.6,
				cached: false,
				transcribed: false,
				fillerWords: null,
			});
			expect(first.pauses).toHaveLength(2);
			expect(first.pauses[0].start).toBeCloseTo(1, 1);
			expect(first.pauses[0].end).toBeCloseTo(2.5, 1);
			expect(first.pauses[1].start).toBeCloseTo(4.4, 1);
			expect(first.pauses[1].end).toBeCloseTo(5.2, 1);
			expect(
				await detector.fillerCuts({ path: "take.wav", paddingSeconds: 0.2 }),
			).toBeNull();

			await rename(
				join(root, "Footage", "take.wav"),
				join(root, "Footage", "moved.wav"),
			);
			expect(
				await detector.detect({ params: { path: "moved.wav" } }),
			).toMatchObject({
				path: "moved.wav",
				cached: true,
				pauses: first.pauses,
			});
			await rename(
				join(root, "Footage", "moved.wav"),
				join(root, "Footage", "take.wav"),
			);

			cached = transcript({ words: [word(["uh", 2.7, 3])] });
			const second = await detector.detect({
				params: {
					path: "take.wav",
					minSeconds: 0.25,
				},
			});
			expect(second).toMatchObject({
				cached: true,
				transcribed: true,
				fillerWords: [{ text: "uh", aligned: true }],
			});
			expect(second.fillerWords?.[0].start).toBeCloseTo(2.5, 1);
			expect(second.fillerWords?.[0].end).toBeCloseTo(3.1, 1);
			const [cut] =
				(await detector.fillerCuts({
					path: "take.wav",
					paddingSeconds: 0.2,
				})) ?? [];
			expect(cut?.start).toBeCloseTo(1.2, 1);
			expect(cut?.end).toBeCloseTo(3.2, 1);
			expect(second.pauses).toHaveLength(3);
			await expect(
				detector.detect({ params: { path: "../take.wav" } }),
			).rejects.toThrow();
			await expect(
				detector.detect({ params: { path: "missing.wav" } }),
			).rejects.toThrow("Expected an existing video or audio file");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(!Bun.which("ffmpeg"))(
	"scans again when Footage is replaced with a file of the same size and modified time",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-pauses-"));
		const detector = createPauseDetector({
			root,
			readTranscript: async () => null,
		});
		try {
			await mkdir(join(root, "Footage"));
			const file = join(root, "Footage", "take.wav");
			await Bun.write(file, silentWav({ seconds: [[3, false]] }));
			const first = await detector.detect({ params: { path: "take.wav" } });
			expect(first.pauses).toEqual([{ start: 0, end: 3 }]);

			// A tone of the same length, with the silence's modified time put back.
			const { atime, mtime, size } = await stat(file);
			await Bun.write(file, silentWav({ seconds: [[3, true]] }));
			await utimes(file, atime, mtime);
			const replaced = await stat(file);
			expect(replaced.size).toBe(size);
			expect(replaced.mtimeMs).toBe(mtime.getTime());

			const second = await detector.detect({ params: { path: "take.wav" } });
			expect(second.cached).toBe(false);
			expect(second.pauses).toEqual([]);
		} finally {
			await detector.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
);

// The fake FFmpeg is a shell script, which Windows can't run.
test.skipIf(process.platform === "win32")(
	"a scan of Footage that changed while it ran isn't cached",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-pauses-"));
		const detector = createPauseDetector({
			root,
			readTranscript: async () => null,
		});
		try {
			await mkdir(join(root, "Footage"));
			const file = join(root, "Footage", "talk.wav");
			await Bun.write(file, "");
			// A fake FFmpeg whose first silence scan rewrites the recording.
			const changed = join(root, "changed");
			const ffmpeg = join(root, "Tools", "ffmpeg");
			await Bun.write(
				ffmpeg,
				[
					"#!/bin/sh",
					'case "$*" in',
					`*silencedetect*) if [ ! -e '${changed}' ]; then : > '${changed}'; printf x >> '${file}'; fi`,
					'  echo "[silencedetect @ 0x1] silence_start: 1" >&2',
					'  echo "[silencedetect @ 0x1] silence_end: 2 | silence_duration: 1" >&2 ;;',
					'*) echo "  Duration: 00:00:05.00, start: 0.000000" >&2',
					'  echo "  Stream #0:0: Audio: pcm_s16le, 48000 Hz, mono" >&2 ;;',
					"esac",
					"",
				].join("\n"),
			);
			await chmod(ffmpeg, 0o755);
			const detect = () => detector.detect({ params: { path: "talk.wav" } });

			await expect(detect()).rejects.toThrow(
				"Footage changed while finding pauses",
			);
			expect(await detect()).toMatchObject({
				cached: false,
				pauses: [{ start: 1, end: 2 }],
			});
			expect(await detect()).toMatchObject({ cached: true });
		} finally {
			await detector.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
);

function ffmpeg(args: string[]) {
	const result = Bun.spawnSync([
		"ffmpeg",
		"-nostdin",
		"-loglevel",
		"error",
		"-y",
		...args,
	]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

test.skipIf(!Bun.which("ffmpeg"))(
	"finds equal pauses at any offset and skips a video without an audio track",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-pauses-"));
		const detector = createPauseDetector({
			root,
			readTranscript: async () => null,
		});
		try {
			await mkdir(join(root, "Footage"));
			await Bun.write(
				join(root, "Footage", "threshold.wav"),
				silentWav({
					seconds: [
						[1, true],
						[0.6, false],
						[6.4, true],
						[0.6, false],
						[1.4, true],
					],
				}),
			);
			expect(
				(await detector.detect({ params: { path: "threshold.wav" } })).pauses,
			).toEqual([
				{ start: 1, end: 1.6 },
				{ start: 8, end: 8.6 },
			]);

			const video = join(root, "Footage", "screen.mp4");
			ffmpeg([
				"-f",
				"lavfi",
				"-i",
				"color=c=black:s=128x72:d=1",
				"-c:v",
				"mpeg4",
				video,
			]);
			expect(
				await detector.detect({ params: { path: "screen.mp4" } }),
			).toMatchObject({
				cached: false,
				hasAudio: false,
				durationSeconds: 1,
				pauses: [],
				pauseSeconds: 0,
			});
			// The scan is cached like any other.
			expect(
				await detector.detect({ params: { path: "screen.mp4" } }),
			).toMatchObject({
				cached: true,
				hasAudio: false,
			});
			expect(
				await detector.fillerCuts({ path: "screen.mp4", paddingSeconds: 0.2 }),
			).toEqual([]);
			await expect(
				extractAudio({
					root,
					source: video,
					wav: join(root, "audio.wav"),
					signal: new AbortController().signal,
				}),
			).rejects.toThrow("screen.mp4 has no audio track");
		} finally {
			await detector.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
);

const request = {
	expectedRevision: 3,
	sections: [],
	falseStarts: [{ projectItemId: "a", sourceIn: 1, sourceOut: 2 }],
};

test("resolves automatic pauses and filler words for every recording on the source sequence", async () => {
	const listed: unknown[] = [];
	const detected: unknown[] = [];
	const sources: RoughCutSources = {
		ok: true,
		sequenceId: "raw",
		items: [
			{ id: "a", name: "A", path: "a.mp4", recordingVersion: "version-a" },
			{ id: "b", name: "B", path: "b.mp4", recordingVersion: "version-b" },
		],
	};
	const resolved = await resolveRoughCutRequest({
		params: {
			...request,
			removeFillerWords: true,
			pauseDetection: { noiseDb: -40 },
		},
		listSources: async (params) => {
			listed.push(params);
			return sources;
		},
		pauseRanges: async (params) => {
			detected.push(params);
			return [{ start: 4, end: 5 }];
		},
		fillerCuts: async ({ path, paddingSeconds }) => {
			expect(paddingSeconds).toBe(0.2);
			return path === "a.mp4" ? [{ start: 7, end: 7.3 }] : [];
		},
	});
	expect(listed).toEqual([{ sequenceId: undefined }]);
	expect(detected).toEqual([
		{ path: "a.mp4", expectedVersion: "version-a", noiseDb: -40 },
		{ path: "b.mp4", expectedVersion: "version-b", noiseDb: -40 },
	]);
	expect(resolved).toEqual({
		plan: {
			...request,
			pausePaddingSeconds: 0.2,
			pauses: [
				{ projectItemId: "a", sourceIn: 4, sourceOut: 5 },
				{ projectItemId: "b", sourceIn: 4, sourceOut: 5 },
			],
			fillerWords: [{ projectItemId: "a", sourceIn: 7, sourceOut: 7.3 }],
			// The cut goes to the sequence the pauses were measured on.
			sequenceId: "raw",
		},
	});
});

test("passes explicit pauses through and refuses fillers without a transcript", async () => {
	const unused = async (): Promise<never> => {
		throw new Error("not expected");
	};
	const pauses = [{ projectItemId: "a", sourceIn: 4, sourceOut: 5 }];
	expect(
		await resolveRoughCutRequest({
			params: { ...request, pauses },
			listSources: unused,
			pauseRanges: unused,
			fillerCuts: unused,
		}),
	).toEqual({
		plan: { ...request, pausePaddingSeconds: 0.2, pauses, fillerWords: [] },
	});
	expect(
		await resolveRoughCutRequest({
			params: { ...request, pauses: [], removeFillerWords: true },
			listSources: async () => ({
				ok: true,
				sequenceId: "raw",
				items: [{ id: "a", name: "A", path: "a.mp4" }],
			}),
			pauseRanges: unused,
			fillerCuts: async () => null,
		}),
	).toEqual({
		result: {
			ok: false,
			code: "INVALID_OP",
			message: expect.stringContaining("Transcribe a.mp4"),
			revision: 3,
		},
	});
	expect(
		await resolveRoughCutRequest({
			params: request,
			listSources: async () => ({
				ok: true,
				sequenceId: "raw",
				items: [{ id: "a", name: "Pasted clip", path: null }],
			}),
			pauseRanges: unused,
			fillerCuts: unused,
		}),
	).toMatchObject({
		result: { ok: false, message: expect.stringContaining("Pasted clip") },
	});
	// The tab reports schema errors in its usual shape.
	const invalid = { ...request, pauses: "sometimes" };
	expect(
		await resolveRoughCutRequest({
			params: invalid,
			listSources: unused,
			pauseRanges: unused,
			fillerCuts: unused,
		}),
	).toEqual({ plan: invalid });
});

test("the plan and apply passes tighten alike and keep captions and gains for the tab", async () => {
	const captions = {
		sources: [
			{ projectItemId: "a", words: [{ start: 0, end: 0.4, text: "Hi" }] },
		],
	};
	const resolve = (pass: object) =>
		resolveRoughCutRequest({
			params: { ...request, captions, ...pass },
			listSources: async () => ({
				ok: true,
				sequenceId: "raw",
				items: [{ id: "a", name: "A", path: "a.mp4" }],
			}),
			pauseRanges: async () => [{ start: 4, end: 5 }],
			fillerCuts: async () => [],
		});
	const sourceGains = [{ projectItemId: "a", gainDb: 3 }];
	const planned = await resolve({ plan: true });
	const applied = await resolve({ sourceGains });
	const tighten = {
		...request,
		pausePaddingSeconds: 0.2,
		pauses: [{ projectItemId: "a", sourceIn: 4, sourceOut: 5 }],
		fillerWords: [],
		sequenceId: "raw",
		captions,
	};
	expect(planned).toEqual({
		plan: { ...tighten, plan: true },
		tightening: {
			pauses: tighten.pauses,
			fillerWords: [],
			sequenceId: "raw",
		},
	});
	expect(applied).toEqual({ plan: { ...tighten, sourceGains } });
	if (!("plan" in applied)) throw new Error("expected a plan");
	expect(roughCutTabRequestSchema.safeParse(applied.plan).success).toBe(true);
});

test("the apply pass cuts the ranges the plan pass resolved, even after a transcript lands", async () => {
	let transcribed = false;
	const resolve = (pass: object) =>
		resolveRoughCutRequest({
			params: { ...request, ...pass },
			listSources: async () => ({
				ok: true,
				sequenceId: "raw",
				items: [{ id: "a", name: "A", path: "a.mp4" }],
			}),
			// The transcript joins two short silences around a click into a pause.
			pauseRanges: async () => (transcribed ? [{ start: 1, end: 1.85 }] : []),
			fillerCuts: async () => [],
		});
	const sourceGains = [{ projectItemId: "a", gainDb: 3 }];
	const planned = await resolve({ plan: true });
	if (!("tightening" in planned) || !planned.tightening)
		throw new Error("expected the plan's tightening");
	expect(planned.tightening).toEqual({
		pauses: [],
		fillerWords: [],
		sequenceId: "raw",
	});

	transcribed = true;
	const applied = await resolve({
		sourceGains,
		tightening: planned.tightening,
	});
	expect(applied).toEqual({
		plan: {
			...request,
			pausePaddingSeconds: 0.2,
			pauses: [],
			fillerWords: [],
			// The apply pass cuts the sequence the plan pass measured.
			sequenceId: "raw",
			sourceGains,
		},
	});
	if (!("plan" in applied)) throw new Error("expected a plan");
	expect(roughCutTabRequestSchema.safeParse(applied.plan).success).toBe(true);
	// Resolving again would cut a pause the gains weren't measured without.
	expect(await resolve({ sourceGains })).toMatchObject({
		plan: { pauses: [{ projectItemId: "a", sourceIn: 1, sourceOut: 1.85 }] },
	});
});

test.skipIf(!Bun.which("ffmpeg"))(
	"keeps the plan's pauses when a transcript lands before apply, and pauses survive an unreadable transcript",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-pauses-"));
		let cached: Transcript | null = null;
		let broken = false;
		const detector = createPauseDetector({
			root,
			readTranscript: async () => {
				if (broken) throw new Error("SPLICE_WHISPER_MODEL is not a file");
				return cached;
			},
		});
		const resolve = (pass: object) =>
			resolveRoughCutRequest({
				params: { ...request, ...pass },
				listSources: async () => ({
					ok: true,
					sequenceId: "raw",
					items: [
						{
							id: "a",
							name: "A",
							path: "click.wav",
							recordingVersion: await footageVersion({
								absolutePath: join(root, "Footage", "click.wav"),
							}),
						},
					],
				}),
				pauseRanges: detector.pauseRanges,
				fillerCuts: detector.fillerCuts,
			});
		try {
			await mkdir(join(root, "Footage"));
			// Two 0.4 s silences around a 50 ms click: too short alone, one pause joined.
			await Bun.write(
				join(root, "Footage", "click.wav"),
				silentWav({
					seconds: [
						[1, true],
						[0.4, false],
						[0.05, true],
						[0.4, false],
						[1, true],
					],
				}),
			);
			const planned = await resolve({ plan: true });
			expect(planned).toMatchObject({
				tightening: { pauses: [], fillerWords: [] },
			});
			if (!("tightening" in planned) || !planned.tightening)
				throw new Error("expected the plan's tightening");

			cached = transcript({
				words: [word(["Hello", 0.2, 0.9]), word(["again", 1.9, 2.5])],
			});
			const joined = await detector.pauseRanges({ path: "click.wav" });
			expect(joined).toHaveLength(1);
			expect(joined[0].start).toBeCloseTo(1, 1);
			expect(joined[0].end).toBeCloseTo(1.85, 1);
			expect(
				(await detector.detect({ params: { path: "click.wav" } })).pauses,
			).toEqual(joined);
			expect(
				await resolve({ sourceGains: [], tightening: planned.tightening }),
			).toMatchObject({ plan: { pauses: [] } });

			broken = true;
			expect(
				await detector.detect({ params: { path: "click.wav" } }),
			).toMatchObject({
				hasAudio: true,
				transcribed: false,
				transcriptError: expect.stringContaining(
					"SPLICE_WHISPER_MODEL is not a file",
				),
				pauses: [],
				fillerWords: null,
			});
			expect(await resolve({})).toMatchObject({ plan: { pauses: [] } });
			await expect(
				detector.fillerCuts({ path: "click.wav", paddingSeconds: 0.2 }),
			).rejects.toThrow("SPLICE_WHISPER_MODEL is not a file");
		} finally {
			await detector.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
);
