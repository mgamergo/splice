import type { Transcript, TranscriptWord } from "@splice/bridge";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { footagePath, invalidParams, resolveRecording } from "./transcription";
import { ffmpegInputArgs, findFfmpeg, run } from "./transcription-tools";

/** Speech on a laptop mic sits well above this; room noise well below it. */
export const DEFAULT_NOISE_DB = -35;
/** Shorter silences are the natural rhythm of speech and stay. */
export const DEFAULT_MIN_PAUSE_SECONDS = 0.6;
/** FFmpeg reports silences this short, so the transcript can join two around a click. */
const SCAN_MIN_SILENCE_SECONDS = 0.1;
/** A sound between two silences that is shorter than this and holds no word is a click, not speech. */
const BRIDGE_SECONDS = 0.12;
/** Bump when cached pause semantics change. */
const CACHE_VERSION = 1;

export const FILLER_WORDS: ReadonlySet<string> = new Set([
	"um",
	"umm",
	"uh",
	"uhh",
	"uhm",
	"erm",
	"er",
	"ah",
	"ahh",
	"hmm",
	"hm",
	"mm",
	"mmm",
]);

export const detectPausesInput = {
	path: footagePath,
	noiseDb: z
		.number()
		.min(-90)
		.max(-10)
		.optional()
		.describe(`Silence threshold in dBFS. Defaults to ${DEFAULT_NOISE_DB}.`),
	minSeconds: z
		.number()
		.min(0.2)
		.max(10)
		.optional()
		.describe(
			`Shortest silence reported as a pause, in seconds. Defaults to ${DEFAULT_MIN_PAUSE_SECONDS}.`,
		),
};
const detectPausesSchema = z.strictObject(detectPausesInput);

export interface TimeRange {
	start: number;
	end: number;
}

const scanSchema = z.object({
	durationSeconds: z.number().nonnegative().nullable(),
	silences: z.array(z.object({ start: z.number(), end: z.number() })),
});
type Scan = z.infer<typeof scanSchema>;

export function silencedetectArgs({
	source,
	noiseDb,
}: {
	source: string;
	noiseDb: number;
}): string[] {
	return [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"info",
		"-nostats",
		...ffmpegInputArgs({ source }),
		"-af",
		`silencedetect=noise=${noiseDb}dB:duration=${SCAN_MIN_SILENCE_SECONDS}`,
		"-f",
		"null",
		"-",
	];
}

/** Reads FFmpeg's stderr. A silence still open at the end runs to the input's duration. */
export function parseSilencedetect({ output }: { output: string }): Scan {
	const silences: TimeRange[] = [];
	let durationSeconds: number | null = null;
	let open: number | null = null;
	for (const line of output.split(/\r?\n/)) {
		const duration = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line);
		if (duration && durationSeconds === null) {
			durationSeconds =
				Number(duration[1]) * 3600 +
				Number(duration[2]) * 60 +
				Number(duration[3]);
			continue;
		}
		const event =
			/\[silencedetect @ [^\]]+\] silence_(start|end): (-?[\d.]+)/.exec(line);
		if (!event) continue;
		const time = Math.max(0, Number(event[2]));
		if (!Number.isFinite(time)) continue;
		if (event[1] === "start") {
			open = time;
		} else if (open !== null) {
			if (time > open) silences.push({ start: open, end: time });
			open = null;
		}
	}
	if (open !== null && durationSeconds !== null && durationSeconds > open)
		silences.push({ start: open, end: durationSeconds });
	return { durationSeconds, silences };
}

function transcriptWords(transcript: Transcript): TranscriptWord[] {
	return transcript.segments.flatMap(({ words }) => words);
}

/**
 * Pauses are FFmpeg's silences: their edges follow the audio. Whisper's word
 * times drift by up to a second around silence (it places words inside
 * stretches of digital silence), so the transcript never moves or vetoes an
 * edge. It only joins two silences around a sound too short for speech, such
 * as a click, when no word overlaps that sound.
 */
export function combineSilencesWithTranscript({
	silences,
	words,
	minSeconds,
}: {
	silences: TimeRange[];
	words: TranscriptWord[] | null;
	minSeconds: number;
}): TimeRange[] {
	const merged: TimeRange[] = [];
	for (const silence of [...silences].sort((a, b) => a.start - b.start)) {
		const previous = merged.at(-1);
		const bridgeable =
			previous &&
			words !== null &&
			silence.start - previous.end <= BRIDGE_SECONDS &&
			!words.some(
				(word) => word.start < silence.start && word.end > previous.end,
			);
		if (previous && (silence.start <= previous.end || bridgeable)) {
			previous.end = Math.max(previous.end, silence.end);
		} else {
			merged.push({ ...silence });
		}
	}
	return merged.filter(({ start, end }) => end - start >= minSeconds);
}

export function normalizeWord(text: string): string {
	return text.toLowerCase().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
}

/** A filler is a short sound between two silences. */
const FILLER_MAX_SECONDS = 1;
/** How far Whisper's time for a word may be from its sound. */
const FILLER_REACH_SECONDS = 0.8;

export type FillerWord = TimeRange & {
	text: string;
	/** Whether start and end were moved to the filler's sound between two silences. */
	aligned: boolean;
	/** The silences around the sound, when aligned. */
	silenceBefore?: TimeRange;
	silenceAfter?: TimeRange;
};

/**
 * English filler words, moved from Whisper's drifting times to their sound:
 * the nearest short sound between two silences that doesn't hold the middle
 * of the words before or after the filler. A filler with no such sound
 * within reach keeps its transcript times and `aligned: false`.
 */
export function findFillerWords({
	transcript,
	silences,
}: {
	transcript: Transcript;
	silences: TimeRange[];
}): FillerWord[] {
	if (!transcript.language.startsWith("en")) return [];
	const words = transcriptWords(transcript);
	const isFiller = (text: string) => FILLER_WORDS.has(normalizeWord(text));
	const sorted = [...silences].sort((a, b) => a.start - b.start);
	const sounds = sorted.slice(1).flatMap((after, index) => {
		const before = sorted[index];
		return after.start > before.end &&
			after.start - before.end <= FILLER_MAX_SECONDS
			? [{ start: before.end, end: after.start, before, after }]
			: [];
	});
	return words.flatMap((word, index) => {
		if (!isFiller(word.text)) return [];
		const neighbors = [
			words
				.slice(0, index)
				.reverse()
				.find(({ text }) => !isFiller(text)),
			words.slice(index + 1).find(({ text }) => !isFiller(text)),
		].flatMap((neighbor) =>
			neighbor ? [(neighbor.start + neighbor.end) / 2] : [],
		);
		const distance = ({ start, end }: TimeRange) =>
			Math.max(0, start - word.end, word.start - end);
		const sound = sounds
			.filter(
				(candidate) =>
					distance(candidate) <= FILLER_REACH_SECONDS &&
					!neighbors.some(
						(middle) => candidate.start <= middle && middle <= candidate.end,
					),
			)
			.sort((a, b) => distance(a) - distance(b))[0];
		return [
			sound
				? {
						start: sound.start,
						end: sound.end,
						text: word.text,
						aligned: true,
						silenceBefore: sound.before,
						silenceAfter: sound.after,
					}
				: { start: word.start, end: word.end, text: word.text, aligned: false },
		];
	});
}

/**
 * The source range removing an aligned filler cuts: the filler and the
 * silences around it, keeping `paddingSeconds` of each silence.
 */
export function fillerCut({
	filler,
	paddingSeconds,
}: {
	filler: FillerWord;
	paddingSeconds: number;
}): TimeRange | null {
	const { silenceBefore, silenceAfter } = filler;
	if (!filler.aligned || !silenceBefore || !silenceAfter) return null;
	return {
		start: Math.min(silenceBefore.start + paddingSeconds, filler.start),
		end: Math.max(silenceAfter.end - paddingSeconds, filler.end),
	};
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

export function createPauseDetector({
	root,
	readTranscript,
}: {
	root: string;
	readTranscript: (input: { path: string }) => Promise<Transcript | null>;
}) {
	const stop = new AbortController();
	const cacheDir = join(root, "Cache", "pauses");
	const scans = new Map<string, Promise<Scan>>();

	async function scan({
		path,
		noiseDb,
	}: {
		path: string;
		noiseDb: number;
	}): Promise<{ scan: Scan; cached: boolean }> {
		const { source, info } = await resolveRecording({ root, path });
		const key = createHash("sha256")
			.update(
				JSON.stringify([CACHE_VERSION, path, info.size, info.mtimeMs, noiseDb]),
			)
			.digest("hex");
		const cachePath = join(cacheDir, `${key}.json`);
		const cached = scanSchema.safeParse(
			await Bun.file(cachePath)
				.json()
				.catch(() => null),
		);
		if (cached.success) return { scan: cached.data, cached: true };
		let pending = scans.get(key);
		if (!pending) {
			pending = (async () => {
				const lines: string[] = [];
				await run({
					command: await findFfmpeg({ root }),
					args: silencedetectArgs({ source, noiseDb }),
					signal: stop.signal,
					onLine: (line) => lines.push(line),
				});
				const result = parseSilencedetect({ output: lines.join("\n") });
				await mkdir(cacheDir, { recursive: true });
				const temporary = await mkdtemp(join(cacheDir, ".scan-"));
				try {
					const file = join(temporary, "scan.json");
					await Bun.write(file, JSON.stringify(result));
					await rename(file, cachePath);
				} finally {
					await rm(temporary, { recursive: true, force: true });
				}
				return result;
			})().finally(() => scans.delete(key));
			scans.set(key, pending);
		}
		return { scan: await pending, cached: false };
	}

	async function analyze(params: unknown) {
		const parsed = detectPausesSchema.safeParse(params);
		if (!parsed.success) throw invalidParams(parsed.error.message);
		const {
			path,
			noiseDb = DEFAULT_NOISE_DB,
			minSeconds = DEFAULT_MIN_PAUSE_SECONDS,
		} = parsed.data;
		const [{ scan: result, cached }, transcript] = await Promise.all([
			scan({ path, noiseDb }),
			readTranscript({ path }),
		]);
		const words = transcript ? transcriptWords(transcript) : null;
		const silences = combineSilencesWithTranscript({
			silences: result.silences,
			words,
			minSeconds: 0,
		});
		return {
			path,
			noiseDb,
			minSeconds,
			cached,
			durationSeconds: result.durationSeconds,
			transcript,
			silences,
			pauses: silences.filter(({ start, end }) => end - start >= minSeconds),
		};
	}

	return {
		async detect(params: unknown) {
			const { transcript, silences, pauses, ...rest } = await analyze(params);
			return {
				...rest,
				transcribed: transcript !== null,
				pauses: pauses.map(({ start, end }) => ({
					start: round(start),
					end: round(end),
				})),
				pauseSeconds: round(
					pauses.reduce((sum, { start, end }) => sum + end - start, 0),
				),
				fillerWords: transcript
					? findFillerWords({ transcript, silences }).map(
							({ start, end, text, aligned }) => ({
								start: round(start),
								end: round(end),
								text,
								aligned,
							}),
						)
					: null,
			};
		},

		/** Source ranges that remove the aligned fillers, or null before transcription. */
		async fillerCuts({
			paddingSeconds,
			...params
		}: {
			path: string;
			noiseDb?: number;
			paddingSeconds: number;
		}): Promise<TimeRange[] | null> {
			const { transcript, silences } = await analyze(params);
			if (!transcript) return null;
			return findFillerWords({ transcript, silences }).flatMap((filler) => {
				const cut = fillerCut({ filler, paddingSeconds });
				return cut ? [cut] : [];
			});
		},

		stop() {
			stop.abort();
		},
	};
}

export type PauseDetector = ReturnType<typeof createPauseDetector>;
