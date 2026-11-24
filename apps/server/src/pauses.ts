import type { Transcript, TranscriptWord } from "@splice/bridge";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { footagePath, invalidParams, resolveRecording } from "./transcription";
import {
	ffmpegInputArgs,
	findFfmpeg,
	parseHasAudio,
	probeRecording,
	SOURCE_TIMELINE_FILTER,
	run,
} from "./transcription-tools";

/** Speech on a laptop mic sits well above this; room noise well below it. */
export const DEFAULT_NOISE_DB = -35;
/** Shorter silences are the natural rhythm of speech and stay. */
export const DEFAULT_MIN_PAUSE_SECONDS = 0.6;
/** FFmpeg reports silences this short, so the transcript can join two around a click. */
const SCAN_MIN_SILENCE_SECONDS = 0.1;
/** A sound between two silences that is shorter than this and holds no word is a click, not speech. */
const BRIDGE_SECONDS = 0.12;
/** Bump when cached pause semantics change. */
const CACHE_VERSION = 3;

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
	/** A video without an audio track has no pauses and is never cut. */
	hasAudio: z.boolean(),
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
		...ffmpegInputArgs({ source }),
		"-map",
		"0:a:0",
		"-af",
		`${SOURCE_TIMELINE_FILTER},silencedetect=noise=${noiseDb}dB:duration=${SCAN_MIN_SILENCE_SECONDS}`,
		"-f",
		"null",
		"-",
	];
}

/** Reads FFmpeg's stderr. A silence still open at the end runs to the input's duration. */
export function parseSilencedetect({
	output,
}: {
	output: string;
}): Omit<Scan, "hasAudio"> {
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

/**
 * Compared in whole milliseconds: subtracting float timestamps makes an exact
 * 600 ms silence at 8.0–8.6 s measure just under 0.6.
 */
export function lastsAtLeast({
	range: { start, end },
	seconds,
}: {
	range: TimeRange;
	seconds: number;
}) {
	return Math.round((end - start) * 1000) >= Math.round(seconds * 1000);
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
	return merged.filter((silence) =>
		lastsAtLeast({ range: silence, seconds: minSeconds }),
	);
}

export function normalizeWord(text: string): string {
	return text.toLowerCase().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
}

/** A filler is a short sound between two silences. */
const FILLER_MAX_SECONDS = 1;
/** How far Whisper's time for a word may be from its sound. */
const FILLER_REACH_SECONDS = 0.8;
/**
 * How much closer to a sound a filler's times must be than a real word's for
 * the filler to keep it. Whisper's word edges drift by tens of milliseconds.
 */
const FILLER_MARGIN_SECONDS = 0.05;

export type FillerWord = TimeRange & {
	text: string;
	/** Whether start and end were moved to the filler's sound between two silences. */
	aligned: boolean;
	/** The silences around the sound, when aligned. */
	silenceBefore?: TimeRange;
	silenceAfter?: TimeRange;
};

/** Seconds that `a` and `b` share. */
const overlap = ({ a, b }: { a: TimeRange; b: TimeRange }) =>
	Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Seconds between `a` and `b`, or 0 when they touch or overlap. */
const gap = ({ a, b }: { a: TimeRange; b: TimeRange }) =>
	Math.max(0, b.start - a.end, a.start - b.end);

/** Seconds `range` shares with `sound`, less the seconds between them. */
const closeness = ({ range, sound }: { range: TimeRange; sound: TimeRange }) =>
	overlap({ a: range, b: sound }) - gap({ a: range, b: sound });

/**
 * English filler words, moved from Whisper's drifting times to their sound:
 * the nearest short sound between two silences. Alignment is conservative,
 * because cutting the wrong sound deletes a real word. A filler stays at its
 * transcript times with `aligned: false` when no free sound is within reach,
 * or when the filler's own times lie more in another sound than in that one,
 * which means Whisper heard it inside continuous speech. A real word claims a
 * sound that holds its middle. Unless it overlaps another sound more, it also
 * claims a sound its times are about as close to as the filler's, counting
 * overlap as closeness and a gap as distance: Whisper can miss a word's sound
 * by a few milliseconds and leave the word in silence. A filler keeps the
 * sound only when its times are clearly closer, so a few milliseconds of
 * drift on either side don't decide which word the sound is.
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
	const spoken = words.filter(({ text }) => !isFiller(text));
	const sorted = [...silences].sort((a, b) => a.start - b.start);
	const audible: Array<TimeRange & { before?: TimeRange; after?: TimeRange }> =
		[
			{ start: Number.NEGATIVE_INFINITY, end: sorted[0]?.start ?? Infinity },
			...sorted.slice(1).map((after, index) => ({
				start: sorted[index].end,
				end: after.start,
				before: sorted[index],
				after,
			})),
			{ start: sorted.at(-1)?.end ?? Infinity, end: Infinity },
		].filter(({ start, end }) => end > start);
	const claims = ({
		word,
		sound,
		filler,
	}: {
		word: TimeRange;
		sound: TimeRange;
		filler: TimeRange;
	}) => {
		const middle = (word.start + word.end) / 2;
		if (sound.start <= middle && middle <= sound.end) return true;
		const shared = overlap({ a: word, b: sound });
		if (audible.some((other) => overlap({ a: word, b: other }) > shared))
			return false;
		// Within the margin the word wins: cutting a real word is worse than
		// keeping a filler.
		return (
			closeness({ range: word, sound }) >=
			closeness({ range: filler, sound }) - FILLER_MARGIN_SECONDS
		);
	};
	return words.flatMap((word) => {
		if (!isFiller(word.text)) return [];
		const distance = (sound: TimeRange) => gap({ a: word, b: sound });
		const sound = audible
			.filter(
				(candidate) =>
					candidate.before &&
					candidate.after &&
					candidate.end - candidate.start <= FILLER_MAX_SECONDS &&
					distance(candidate) <= FILLER_REACH_SECONDS &&
					!spoken.some((other) =>
						claims({ word: other, sound: candidate, filler: word }),
					),
			)
			// Two sounds can both touch the filler's times; the one it overlaps
			// more is the one Whisper heard.
			.sort(
				(a, b) =>
					distance(a) - distance(b) ||
					overlap({ a: b, b: word }) - overlap({ a, b: word }),
			)[0];
		const heardElsewhere =
			sound !== undefined &&
			audible.some(
				(other) =>
					other !== sound &&
					overlap({ a: other, b: word }) > overlap({ a: sound, b: word }),
			);
		return [
			sound && !heardElsewhere
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
				const command = await findFfmpeg({ root });
				const probe = await probeRecording({
					command,
					source,
					signal: stop.signal,
				});
				let result: Scan;
				if (parseHasAudio({ output: probe })) {
					const lines: string[] = [];
					await run({
						command,
						args: silencedetectArgs({ source, noiseDb }),
						signal: stop.signal,
						onLine: (line) => lines.push(line),
					});
					result = {
						...parseSilencedetect({ output: lines.join("\n") }),
						hasAudio: true,
					};
				} else {
					const { durationSeconds } = parseSilencedetect({ output: probe });
					result = { durationSeconds, hasAudio: false, silences: [] };
				}
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
			hasAudio: result.hasAudio,
			transcript,
			silences,
			pauses: silences.filter((silence) =>
				lastsAtLeast({ range: silence, seconds: minSeconds }),
			),
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

		/**
		 * Source ranges that remove the aligned fillers: none for a recording
		 * without audio, and null before transcription.
		 */
		async fillerCuts({
			paddingSeconds,
			...params
		}: {
			path: string;
			noiseDb?: number;
			paddingSeconds: number;
		}): Promise<TimeRange[] | null> {
			const { hasAudio, transcript, silences } = await analyze(params);
			if (!hasAudio) return [];
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
