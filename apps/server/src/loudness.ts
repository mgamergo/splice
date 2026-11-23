import {
	type AudioSource,
	CLIP_GAIN_DB,
	DEFAULT_TARGET_LUFS,
	MAX_TRUE_PEAK_DBTP,
	mergeSourceRanges,
	type SourceGain,
	type SourceRange,
	sourceRangeSchema,
} from "@splice/bridge/ops";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	ffmpegInputArgs,
	findFfmpeg,
	run,
	SOURCE_TIMELINE_FILTER,
} from "./transcription-tools";
import { footagePath, invalidParams, resolveRecording } from "./transcription";

export const measureLoudnessInput = {
	path: footagePath,
	ranges: z
		.array(sourceRangeSchema)
		.min(1)
		.max(2000)
		.optional()
		.describe(
			"Source ranges in seconds to measure together, e.g. what a cut keeps. Defaults to the whole file.",
		),
};
const measureSchema = z.object(measureLoudnessInput);

/** EBU R128 loudness of a recording, or of the ranges measured. */
export const loudnessMeasurementSchema = z.object({
	/** Null when no audio passes the gate: silence, or less than 400 ms. */
	integratedLufs: z.number().nullable(),
	truePeakDbtp: z.number().nullable(),
	lraLu: z.number(),
});
export type LoudnessMeasurement = z.infer<typeof loudnessMeasurementSchema>;

export function loudnessCacheKey({
	path,
	size,
	mtimeMs,
	ranges,
}: {
	path: string;
	size: number;
	mtimeMs: number;
	ranges: SourceRange[] | null;
}): string {
	// Bump the version when the measurement changes.
	return createHash("sha256")
		.update(JSON.stringify([1, path, size, mtimeMs, ranges]))
		.digest("hex");
}

function seconds(value: number): string {
	return value.toFixed(6);
}

export function ebur128Args({
	source,
	ranges,
}: {
	source: string;
	ranges: SourceRange[] | null;
}): string[] {
	const filters = [SOURCE_TIMELINE_FILTER];
	if (ranges) {
		const selected = ranges
			.map(({ start, end }) => `gte(t,${seconds(start)})*lt(t,${seconds(end)})`)
			.join("+");
		// Short frames keep each range boundary within 10 ms at 48 kHz.
		filters.push("asetnsamples=n=480:p=0", `aselect='${selected}'`);
	}
	// The editor plays mono sources on both stereo channels, so measure them
	// that way too. Per-frame lines go to the verbose level, below what is read.
	filters.push("ebur128=peak=true:dualmono=true:framelog=verbose");
	return [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"info",
		...ffmpegInputArgs({ source }),
		"-af",
		filters.join(","),
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
	// -70 LUFS is the absolute gate: nothing was loud enough to measure, and
	// the peak of no samples reads as 0 dBFS.
	if (integrated === null || integrated <= -70)
		return { integratedLufs: null, truePeakDbtp: null, lraLu: 0 };
	return { integratedLufs: integrated, truePeakDbtp: peak, lraLu: lra };
}

/**
 * FFmpeg prints the true peak to 0.1 dB, so the real peak can be up to this
 * much above the reading. Gains leave room for it to keep the cap.
 */
export const PEAK_READING_MARGIN_DB = 0.05;

export interface LoudnessGain {
	gainDb: number;
	/** Integrated loudness after the gain. */
	expectedLufs: number;
	expectedTruePeakDbtp: number | null;
	/** What kept the gain short of the target, if anything. */
	limitedBy: "true_peak" | "max_gain" | null;
}

/**
 * The clip gain that brings a measurement to the target, short of pushing the
 * true peak above `maxTruePeakDbtp`. Null when there is nothing to measure.
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
	if (integratedLufs === null) return null;
	const wanted = targetLufs - integratedLufs;
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
		expectedLufs: round(integratedLufs + gainDb),
		expectedTruePeakDbtp:
			truePeakDbtp === null ? null : round(truePeakDbtp + gainDb),
		limitedBy,
	};
}

export type MeasureLoudness = (request: {
	path: string;
	ranges: SourceRange[];
}) => Promise<LoudnessMeasurement>;

export type SourceLoudness = {
	projectItemId: string;
	path: string | null;
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
	for (const { projectItemId, path, ranges } of audioSources) {
		if (path === null) {
			sources.push({
				projectItemId,
				path,
				skipped:
					"Stored in the browser, not under Footage, so it can't be measured.",
			});
			continue;
		}
		const measured = await measure({ path, ranges });
		const gain = loudnessGain({ measurement: measured, targetLufs });
		if (!gain) {
			sources.push({
				projectItemId,
				path,
				skipped: "Silent or shorter than 400 ms.",
			});
			continue;
		}
		sourceGains.push({ projectItemId, gainDb: gain.gainDb });
		sources.push({ projectItemId, path, measured, gain });
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
	const command = await findFfmpeg({ root });
	const summary: string[] = [];
	await run({
		command,
		args: ebur128Args({ source, ranges }),
		signal,
		onLine(line) {
			if (summary.length > 0 || line.includes("Summary:")) summary.push(line);
		},
	});
	return parseEbur128Summary(summary.join("\n"));
}

/**
 * Measures Footage loudness with FFmpeg, cached under Cache/loudness.
 *
 * Noise reduction (off by default, see docs/decisions.md) isn't built yet.
 * It changes loudness, so when it lands, measure its output, not the source.
 */
export function createLoudnessMeter({
	root,
	measure = runEbur128,
}: {
	root: string;
	measure?: typeof runEbur128;
}) {
	const stop = new AbortController();
	const signal = stop.signal;
	const cacheDir = join(root, "Cache", "loudness");
	const active = new Map<
		string,
		Promise<LoudnessMeasurement & { cached: boolean }>
	>();

	async function identify({
		path,
		ranges,
	}: {
		path: string;
		ranges: SourceRange[] | null;
	}) {
		const { source, info } = await resolveRecording({ root, path });
		const key = loudnessCacheKey({
			path,
			size: info.size,
			mtimeMs: info.mtimeMs,
			ranges,
		});
		return { source, key, cachePath: join(cacheDir, `${key}.json`) };
	}

	async function measureAndCache({
		path,
		ranges,
		source,
		key,
		cachePath,
	}: {
		path: string;
		ranges: SourceRange[] | null;
		source: string;
		key: string;
		cachePath: string;
	}): Promise<LoudnessMeasurement> {
		const measurement = await measure({ root, source, ranges, signal });
		const current = await identify({ path, ranges });
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
			const { path } = parsed.data;
			const ranges = parsed.data.ranges
				? mergeSourceRanges(parsed.data.ranges)
				: null;
			const { source, key, cachePath } = await identify({ path, ranges });
			signal.throwIfAborted();
			let pending = active.get(key);
			if (!pending) {
				pending = readCache(cachePath).then(async (cached) =>
					cached
						? { ...cached, cached: true }
						: {
								...(await measureAndCache({
									path,
									ranges,
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
			return { path, ranges, ...(await pending) };
		},

		async stop() {
			stop.abort();
			await Promise.allSettled(active.values());
		},
	};
}
