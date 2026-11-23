import {
	type AudioSource,
	CLIP_GAIN_DB,
	DEFAULT_TARGET_LUFS,
	MAX_TRUE_PEAK_DBTP,
	type SourceGain,
	type SourceRange,
	sourceRangeSchema,
} from "@splice/bridge/ops";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	ffmpegInputArgs,
	findFfmpeg,
	run,
	SOURCE_TIMELINE_FILTER,
} from "./transcription-tools";
import { mediaTypeForPath } from "./footage";
import { footagePath, invalidParams, resolveRecording } from "./transcription";
import { NOISE_REDUCTION_VERSION, type NoiseReducer } from "./noise-reduction";

export const measureLoudnessInput = {
	path: footagePath,
	ranges: z
		.array(sourceRangeSchema)
		.min(1)
		.max(5000)
		.optional()
		.describe(
			"Source ranges in seconds to measure together, e.g. what a cut keeps, one per clip: a range listed twice counts twice. Defaults to the whole file.",
		),
	noiseReduction: z
		.boolean()
		.optional()
		.describe(
			"Measure the audio after noise reduction, as clips with it on play and export.",
		),
};
const measureSchema = z.object(measureLoudnessInput);

/** EBU R128 loudness of a recording, or of the ranges measured. */
export const loudnessMeasurementSchema = z.object({
	/** Null when no audio passes the gate: silence, or less than 400 ms. */
	integratedLufs: z.number().nullable(),
	/** Null for silence. Measured even when the audio is too short to gate. */
	truePeakDbtp: z.number().nullable(),
	lraLu: z.number(),
});
export type LoudnessMeasurement = z.infer<typeof loudnessMeasurementSchema>;

export function loudnessCacheKey({
	path,
	size,
	mtimeMs,
	ranges,
	noiseReduction = false,
}: {
	path: string;
	size: number;
	mtimeMs: number;
	ranges: SourceRange[] | null;
	noiseReduction?: boolean;
}): string {
	// Bump the version when the measurement changes.
	const key: unknown[] = [4, path, size, mtimeMs, ranges];
	if (noiseReduction) key.push({ noiseReduction: NOISE_REDUCTION_VERSION });
	return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}

function seconds(value: number): string {
	return value.toFixed(6);
}

const METER =
	// The editor plays mono sources on both stereo channels, so measure them
	// that way too. Per-frame lines go to the verbose level, below what is read.
	"ebur128=peak=true:dualmono=true:framelog=verbose";

/**
 * An ffconcat list that plays the ranges back to back in order, so a range
 * listed twice plays twice and joins between them are measured as heard.
 * FFmpeg reads one range at a time, so memory stays flat however many ranges
 * or repeats, and the list goes in a file to keep the command line short.
 * A range starts at the exact sample for PCM, and can start a packet early for
 * compressed audio; it can run on to the end of the packet holding its out
 * point. Extra samples only ever read louder, so the gain errs quieter.
 * The source must hold audio alone: in the concat demuxer, a packet of any
 * stream past the out point ends the range.
 */
export function concatList({
	source,
	ranges,
}: {
	source: string;
	ranges: SourceRange[];
}): string {
	const file = `file '${source.replaceAll("'", "'\\''")}'`;
	return [
		"ffconcat version 1.0",
		...ranges.flatMap(({ start, end }) => [
			file,
			`inpoint ${seconds(start)}`,
			`outpoint ${seconds(end)}`,
		]),
		"",
	].join("\n");
}

export function ebur128Args({
	source,
	concat = false,
}: {
	/** The recording, or with `concat`, an ffconcat list of its ranges. */
	source: string;
	concat?: boolean;
}): string[] {
	return [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"info",
		...ffmpegInputArgs({ source, concat }),
		"-map",
		"0:a:0",
		"-af",
		`${SOURCE_TIMELINE_FILTER},${METER}`,
		"-f",
		"null",
		"-",
	];
}

/** Reads the summary FFmpeg's `ebur128` filter logs when it finishes. */
export function parseEbur128Summary(log: string): LoudnessMeasurement {
	const start = log.lastIndexOf("Summary:");
	if (start === -1) throw new Error("FFmpeg printed no loudness summary.");
	const summary = log.slice(start);
	const read = (pattern: RegExp) => {
		const match = pattern.exec(summary)?.[1];
		if (match === undefined)
			throw new Error("FFmpeg printed an unexpected loudness summary.");
		return match === "-inf" ? null : Number(match);
	};
	const integrated = read(/\bI:\s+(-inf|-?\d+(?:\.\d+)?) LUFS/);
	const lra = read(/\bLRA:\s+(-?\d+(?:\.\d+)?) LU\b/) ?? 0;
	const peak = read(/\bPeak:\s+(-inf|-?\d+(?:\.\d+)?) dBFS/);
	// The peak of no samples at all reads as 0 dBFS.
	if (log.includes("Output file is empty"))
		return { integratedLufs: null, truePeakDbtp: null, lraLu: 0 };
	// -70 LUFS is the absolute gate: nothing was loud enough, or long enough,
	// to measure. The true peak still holds, and short clips still need its cap.
	if (integrated === null || integrated <= -70)
		return { integratedLufs: null, truePeakDbtp: peak, lraLu: 0 };
	return { integratedLufs: integrated, truePeakDbtp: peak, lraLu: lra };
}

/**
 * FFmpeg prints the true peak to 0.1 dB, so the real peak can be up to this
 * much above the reading. Gains leave room for it to keep the cap.
 */
export const PEAK_READING_MARGIN_DB = 0.05;

export interface LoudnessGain {
	gainDb: number;
	/** Integrated loudness after the gain, or null when it can't be measured. */
	expectedLufs: number | null;
	expectedTruePeakDbtp: number | null;
	/** What kept the gain short of the target, if anything. */
	limitedBy: "true_peak" | "max_gain" | null;
}

/**
 * The clip gain that brings a measurement to the target, short of pushing the
 * true peak above `maxTruePeakDbtp`. Audio too short to gate keeps its source
 * level unless its peak is over the cap. Null for silence.
 */
export function loudnessGain({
	measurement,
	targetLufs = DEFAULT_TARGET_LUFS,
	maxTruePeakDbtp = MAX_TRUE_PEAK_DBTP,
}: {
	measurement: LoudnessMeasurement;
	targetLufs?: number;
	maxTruePeakDbtp?: number;
}): LoudnessGain | null {
	const { integratedLufs, truePeakDbtp } = measurement;
	if (integratedLufs === null && truePeakDbtp === null) return null;
	const wanted = integratedLufs === null ? 0 : targetLufs - integratedLufs;
	const headroom =
		truePeakDbtp === null
			? Infinity
			: maxTruePeakDbtp - truePeakDbtp - PEAK_READING_MARGIN_DB;
	let gain = Math.min(wanted, headroom, CLIP_GAIN_DB.max);
	let limitedBy: LoudnessGain["limitedBy"] =
		gain === wanted ? null : gain === headroom ? "true_peak" : "max_gain";
	if (gain < CLIP_GAIN_DB.min) {
		gain = CLIP_GAIN_DB.min;
		limitedBy = "max_gain";
	}
	// Round down, so rounding never lifts the peak over the cap.
	const gainDb = Math.floor(gain * 100 + 1e-9) / 100;
	const round = (value: number) => Math.round(value * 10) / 10;
	return {
		gainDb,
		expectedLufs:
			integratedLufs === null ? null : round(integratedLufs + gainDb),
		expectedTruePeakDbtp:
			truePeakDbtp === null ? null : round(truePeakDbtp + gainDb),
		limitedBy,
	};
}

/** The Footage file a measurement asked for isn't there. */
export class MissingFootageError extends Error {}

/** `splice` couldn't measure the recording, for example a damaged file. */
export class UnmeasurableError extends Error {}

export type MeasureLoudness = (request: {
	path: string;
	ranges: SourceRange[];
	noiseReduction: boolean;
}) => Promise<LoudnessMeasurement>;

const MISSING = "Missing from Footage, so playback skips it. Relink it first.";

export type SourceLoudness = {
	projectItemId: string;
	path: string | null;
	noiseReduction: boolean;
} & (
	| { measured: LoudnessMeasurement; gain: LoudnessGain }
	| { skipped: string }
);

/** Measures what each source contributes and the gain that normalizes it. */
export async function planSourceGains({
	audioSources,
	targetLufs = DEFAULT_TARGET_LUFS,
	measure,
}: {
	audioSources: AudioSource[];
	targetLufs?: number;
	measure: MeasureLoudness;
}): Promise<{ sourceGains: SourceGain[]; sources: SourceLoudness[] }> {
	const sourceGains: SourceGain[] = [];
	const sources: SourceLoudness[] = [];
	// One at a time: each measurement already decodes a whole file.
	for (const {
		projectItemId,
		path,
		missing,
		ranges,
		noiseReduction,
	} of audioSources) {
		if (path === null) {
			sources.push({
				projectItemId,
				path,
				noiseReduction,
				skipped:
					"Stored in the browser, not under Footage, so it can't be measured.",
			});
			continue;
		}
		if (missing) {
			sources.push({ projectItemId, path, noiseReduction, skipped: MISSING });
			continue;
		}
		let measured: LoudnessMeasurement;
		try {
			measured = await measure({ path, ranges, noiseReduction });
		} catch (error) {
			// One recording that can't be measured keeps its level; the rest
			// are still normalized.
			if (error instanceof UnmeasurableError) {
				sources.push({
					projectItemId,
					path,
					noiseReduction,
					skipped: `Couldn't be measured: ${error.message}`,
				});
				continue;
			}
			if (!(error instanceof MissingFootageError)) throw error;
			sources.push({ projectItemId, path, noiseReduction, skipped: MISSING });
			continue;
		}
		const gain = loudnessGain({ measurement: measured, targetLufs });
		if (!gain) {
			sources.push({ projectItemId, path, noiseReduction, skipped: "Silent." });
			continue;
		}
		sourceGains.push({ projectItemId, gainDb: gain.gainDb });
		sources.push({ projectItemId, path, noiseReduction, measured, gain });
	}
	return { sourceGains, sources };
}

async function readCache(
	cachePath: string,
): Promise<LoudnessMeasurement | null> {
	try {
		const parsed = loudnessMeasurementSchema.safeParse(
			await Bun.file(cachePath).json(),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * The recording's first audio stream alone, copied without re-encoding into a
 * cached Matroska file, so other streams can't end a range early. Audio files
 * are used as they are.
 */
async function audioOnly({
	command,
	source,
	cacheDir,
	signal,
}: {
	command: string;
	source: string;
	cacheDir: string;
	signal: AbortSignal;
}): Promise<string> {
	if (mediaTypeForPath(source)?.startsWith("audio/")) return source;
	const { size, mtimeMs } = await stat(source);
	const key = createHash("sha256")
		.update(JSON.stringify([resolve(source), size, mtimeMs]))
		.digest("hex");
	const audio = join(cacheDir, `audio-${key}.mka`);
	if (await access(audio).then(() => true, () => false)) return audio;
	// Each copy is written in its own folder, then moved into place whole, so
	// measurements of the same recording never share a half-written file.
	const job = await mkdtemp(join(cacheDir, ".audio-"));
	try {
		const partial = join(job, "audio.mka");
		await run({
			command,
			args: [
				"-nostdin",
				"-hide_banner",
				"-loglevel",
				"error",
				...ffmpegInputArgs({ source }),
				"-map",
				"0:a:0",
				"-c",
				"copy",
				"-f",
				"matroska",
				partial,
			],
			signal,
		});
		await rename(partial, audio).catch(async (error) => {
			// Another measurement published the same copy first.
			if (!(await access(audio).then(() => true, () => false))) throw error;
		});
	} finally {
		await rm(job, { recursive: true, force: true });
	}
	return audio;
}

export async function runEbur128({
	root,
	source,
	ranges,
	signal,
}: {
	root: string;
	source: string;
	ranges: SourceRange[] | null;
	signal: AbortSignal;
}): Promise<LoudnessMeasurement> {
	if (ranges?.length === 0)
		return { integratedLufs: null, truePeakDbtp: null, lraLu: 0 };
	const command = await findFfmpeg({ root });
	const cacheDir = join(root, "Cache", "loudness");
	await mkdir(cacheDir, { recursive: true });
	const job = await mkdtemp(join(cacheDir, ".ranges-"));
	try {
		let input = source;
		if (ranges) {
			const audio = await audioOnly({ command, source, cacheDir, signal });
			input = join(job, "ranges.ffconcat");
			// The list's paths are relative to the list itself.
			await writeFile(input, concatList({ source: resolve(audio), ranges }));
		}
		const log: string[] = [];
		await run({
			command,
			args: ebur128Args({ source: input, concat: ranges !== null }),
			signal,
			onLine(line) {
				if (
					log.length > 0 ||
					line.includes("Summary:") ||
					line.includes("Output file is empty")
				)
					log.push(line);
			},
		});
		return parseEbur128Summary(log.join("\n"));
	} finally {
		await rm(job, { recursive: true, force: true });
	}
}

/**
 * Measures Footage loudness with FFmpeg, cached under Cache/loudness. Noise
 * reduction lowers loudness, so with it on, the noise-reduced render is
 * measured instead of the source.
 */
export function createLoudnessMeter({
	root,
	noiseReduction,
	measure = runEbur128,
}: {
	root: string;
	noiseReduction: Pick<NoiseReducer, "ensure">;
	measure?: typeof runEbur128;
}) {
	const stop = new AbortController();
	const signal = stop.signal;
	const cacheDir = join(root, "Cache", "loudness");
	const active = new Map<
		string,
		Promise<LoudnessMeasurement & { cached: boolean }>
	>();

	type Target = {
		path: string;
		ranges: SourceRange[] | null;
		denoised: boolean;
	};

	async function identify({ path, ranges, denoised }: Target) {
		const { source, info } = await resolveRecording({ root, path });
		const key = loudnessCacheKey({
			path,
			size: info.size,
			mtimeMs: info.mtimeMs,
			ranges,
			noiseReduction: denoised,
		});
		return { source, key, cachePath: join(cacheDir, `${key}.json`) };
	}

	async function measureAndCache({
		target,
		source,
		key,
		cachePath,
	}: {
		target: Target;
		source: string;
		key: string;
		cachePath: string;
	}): Promise<LoudnessMeasurement> {
		const input = target.denoised
			? (await noiseReduction.ensure({ path: target.path })).file
			: source;
		const measurement = await measure({
			root,
			source: input,
			ranges: target.ranges,
			signal,
		});
		const current = await identify(target);
		if (current.key !== key)
			throw new Error("Footage changed while measuring. Measure it again.");
		await mkdir(cacheDir, { recursive: true });
		const temporary = await mkdtemp(join(cacheDir, ".job-"));
		try {
			const pending = join(temporary, "loudness.json");
			await Bun.write(pending, JSON.stringify(measurement));
			await rename(pending, cachePath);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
		return measurement;
	}

	return {
		async measure(params: unknown) {
			const parsed = measureSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { path, noiseReduction: denoised = false } = parsed.data;
			// Order matters: ranges play back to back, as they play in the sequence.
			const ranges =
				parsed.data.ranges?.map(({ start, end }) => ({ start, end })) ?? null;
			const target = { path, ranges, denoised };
			const { source, key, cachePath } = await identify(target);
			signal.throwIfAborted();
			let pending = active.get(key);
			if (!pending) {
				pending = readCache(cachePath).then(async (cached) =>
					cached
						? { ...cached, cached: true }
						: {
								...(await measureAndCache({
									target,
									source,
									key,
									cachePath,
								})),
								cached: false,
							},
				);
				active.set(key, pending);
				void pending.catch(() => undefined).finally(() => active.delete(key));
			}
			return { path, ranges, noiseReduction: denoised, ...(await pending) };
		},

		async stop() {
			stop.abort();
			await Promise.allSettled(active.values());
		},
	};
}
