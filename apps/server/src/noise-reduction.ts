import { DENOISED_AUDIO } from "@splice/bridge";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	ffmpegInput,
	ffmpegInputArgs,
	findFfmpeg,
	run,
} from "./transcription-tools";
import { footagePath, invalidParams, resolveRecording } from "./transcription";
import { createSharedWork } from "./shared-work";
import { type FileIdentity, fileIdentity } from "./file-identity";

export const renderNoiseReductionInput = { path: footagePath };
const renderSchema = z.object(renderNoiseReductionInput);

/** Bump when the filters change, so earlier renders aren't reused. */
export const NOISE_REDUCTION_VERSION = 4;
/** Length of the quiet stretch the noise profile is learned from. */
export const NOISE_WINDOW_SECONDS = 1;
/** The quietest window counts as noise only this far below the loud windows. */
const MIN_NOISE_CONTRAST_DB = 15;
/** Quieter windows are digital silence (a muted mic), with no noise to learn. */
const DIGITAL_SILENCE_DB = -90;
/** Recordings are scanned and rendered at this rate, so sample counts are fixed. */
const SAMPLE_RATE = 48_000;
const WINDOW_SAMPLES = SAMPLE_RATE * NOISE_WINDOW_SECONDS;
/**
 * afftdn's output lags its input by this many samples at 48 kHz, and it drops
 * the input's last ones. Renders pad the end and trim the start by this much,
 * so the audio stays on the source timeline.
 */
export const AFFTDN_LATENCY_SAMPLES = 1_200;
/** Starts the first audio stream at 0, fills gaps, and resamples to 48 kHz. */
const TIMELINE_FILTER = `aresample=${SAMPLE_RATE}:async=1:first_pts=0`;

/**
 * A 4-pole high-pass at 80 Hz, below the voice: removes mains hum
 * fundamentals and rumble, which afftdn's coarse bands leave behind.
 */
const RUMBLE_FILTER = "highpass=f=80:poles=2,highpass=f=80:poles=2";
/**
 * Up to 20 dB of reduction, from a profile sampled in a quiet stretch. afftdn
 * reduces little of the noise above its noise floor, so the floor is set to the
 * stretch's level.
 */
export function sampledDenoiseFilter({ rmsDb }: NoiseWindow): string {
	// afftdn accepts a floor from -80 to -20 dB.
	const floor = Math.min(-20, Math.max(-80, Math.round(rmsDb)));
	return `afftdn=nr=20:nf=${floor}`;
}
/** Without a quiet stretch, afftdn tracks the floor itself, more gently. */
const TRACKED_DENOISE_FILTER = "afftdn=nr=12:nf=-50:tn=1";

/** A quiet stretch of a recording, in source seconds. */
export interface NoiseWindow {
	start: number;
	rmsDb: number;
}

/** Identifies a render by the source file's path and identity. */
export function denoiseCacheKey({
	path,
	info,
}: {
	path: string;
	info: FileIdentity;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([NOISE_REDUCTION_VERSION, path, ...fileIdentity(info)]),
		)
		.digest("hex");
}

function seconds(value: number): string {
	return value.toFixed(6);
}

/** Logs the RMS level and sample count of each window of the recording, in order. */
export function noiseScanArgs({ source }: { source: string }): string[] {
	return [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"info",
		...ffmpegInputArgs({ source }),
		"-map",
		"0:a:0",
		"-af",
		[
			TIMELINE_FILTER,
			`asetnsamples=n=${WINDOW_SAMPLES}:p=0`,
			"astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level+Number_of_samples",
			"ametadata=mode=print",
		].join(","),
		"-f",
		"null",
		"-",
	];
}

const SCAN_LINE =
	/lavfi\.astats\.Overall\.(RMS_level|Number_of_samples)=(-inf|-?\d+(?:\.\d+)?)/;

/** One window's measurements in a line of `noiseScanArgs` output, if any. */
export function parseNoiseScanLine(
	line: string,
): { rmsDb: number } | { samples: number } | null {
	const match = SCAN_LINE.exec(line);
	if (!match) return null;
	const value = match[2] === "-inf" ? -Infinity : Number(match[2]);
	return match[1] === "RMS_level" ? { rmsDb: value } : { samples: value };
}

/** A scanned window: its RMS level and how many samples it holds. */
export interface ScannedWindow {
	rmsDb: number;
	samples: number;
}

/**
 * The quietest window that still holds noise, or null when no window is
 * clearly quieter than the speech (nothing but talking, or too short).
 */
export function pickNoiseWindow(scanned: ScannedWindow[]): NoiseWindow | null {
	const windows = scanned
		.map(({ rmsDb, samples }, index) => ({
			start: index * NOISE_WINDOW_SECONDS,
			rmsDb,
			samples,
		}))
		// The last window can be partial, too short to learn a profile from.
		.filter(
			({ rmsDb, samples }) =>
				samples >= WINDOW_SAMPLES && rmsDb > DIGITAL_SILENCE_DB,
		)
		.map(({ start, rmsDb }) => ({ start, rmsDb }));
	if (windows.length < 2) return null;
	const sorted = windows.map(({ rmsDb }) => rmsDb).sort((a, b) => a - b);
	// The 90th percentile by nearest rank, so of two windows it's the louder.
	const loud = sorted[Math.round((sorted.length - 1) * 0.9)];
	const quietest = windows.reduce((best, window) =>
		window.rmsDb < best.rmsDb ? window : best,
	);
	return loud - quietest.rmsDb >= MIN_NOISE_CONTRAST_DB ? quietest : null;
}

/**
 * Writes the noise window, cut from the same gap-filled timeline the scan
 * measured, and logs how many samples it holds so far as it writes them.
 */
export function noiseProfileArgs({
	source,
	window,
	output,
}: {
	source: string;
	window: NoiseWindow;
	output: string;
}): string[] {
	const start = Math.round(window.start * SAMPLE_RATE);
	return [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"info",
		...ffmpegInputArgs({ source }),
		"-map",
		"0:a:0",
		"-af",
		[
			TIMELINE_FILTER,
			`atrim=start_sample=${start}:end_sample=${start + WINDOW_SAMPLES}`,
			"asetpts=PTS-STARTPTS",
			"astats=metadata=1:reset=0:measure_perchannel=none:measure_overall=Number_of_samples",
			"ametadata=mode=print",
		].join(","),
		"-c:a",
		"pcm_f32le",
		"-f",
		"wav",
		"-y",
		output,
	];
}

/**
 * Writes the recording's noise window to `output`. The render cuts off exactly
 * one window's samples after learning from them, so a shorter window would cut
 * the recording's start instead: it throws rather than render that.
 */
export async function extractNoiseProfile({
	command,
	source,
	window,
	output,
	signal,
}: {
	command: string;
	source: string;
	window: NoiseWindow;
	output: string;
	signal: AbortSignal;
}): Promise<void> {
	let samples = 0;
	await run({
		command,
		args: noiseProfileArgs({ source, window, output }),
		signal,
		onLine(line) {
			const parsed = parseNoiseScanLine(line);
			// A running count, so the last one is the total.
			if (parsed && "samples" in parsed) samples = parsed.samples;
		},
	});
	if (samples !== WINDOW_SAMPLES)
		throw new Error(
			`The noise profile at ${seconds(window.start)} s held ${samples} samples, not ${WINDOW_SAMPLES}.`,
		);
}

/** The noise window, written to its own file by `extractNoiseProfile`. */
export interface NoiseProfile {
	file: string;
	window: NoiseWindow;
}

/**
 * Renders the recording's first audio stream with noise reduction as WAV, on
 * the source timeline. With a noise profile, it is played in first so afftdn
 * learns from it, and is then cut off.
 */
export function denoiseArgs({
	source,
	output,
	profile,
}: {
	source: string;
	output: string;
	profile: NoiseProfile | null;
}): string[] {
	const head = ["-nostdin", "-hide_banner", "-loglevel", "error", "-nostats"];
	// RF64 once the render passes WAV's 4 GiB limit.
	const tail = [
		"-c:a",
		"pcm_s16le",
		"-f",
		"wav",
		"-rf64",
		"auto",
		"-y",
		output,
	];
	const padEnd = `apad=pad_len=${AFFTDN_LATENCY_SAMPLES}`;
	if (!profile)
		return [
			...head,
			...ffmpegInputArgs({ source }),
			"-map",
			"0:a:0",
			"-af",
			[
				TIMELINE_FILTER,
				RUMBLE_FILTER,
				padEnd,
				TRACKED_DENOISE_FILTER,
				`atrim=start_sample=${AFFTDN_LATENCY_SAMPLES}`,
				"asetpts=PTS-STARTPTS",
			].join(","),
			...tail,
		];
	const length = seconds(NOISE_WINDOW_SECONDS);
	return [
		...head,
		...ffmpegInput({ source: profile.file }),
		...ffmpegInput({ source }),
		"-filter_complex",
		[
			`[1:a:0]${TIMELINE_FILTER}[recording]`,
			[
				"[0:a:0][recording]concat=n=2:v=0:a=1",
				RUMBLE_FILTER,
				padEnd,
				`asendcmd=c='0 afftdn sn start;${length} afftdn sn stop'`,
				sampledDenoiseFilter(profile.window),
				`atrim=start_sample=${WINDOW_SAMPLES + AFFTDN_LATENCY_SAMPLES}`,
				"asetpts=PTS-STARTPTS[out]",
			].join(","),
		].join(";"),
		"-map",
		"[out]",
		...tail,
	];
}

export type RenderDenoised = (request: {
	root: string;
	source: string;
	/** In a folder of the render's own, which holds its other files too. */
	output: string;
	signal: AbortSignal;
}) => Promise<{ noiseWindow: NoiseWindow | null }>;

export const renderDenoised: RenderDenoised = async ({
	root,
	source,
	output,
	signal,
}) => {
	const command = await findFfmpeg({ root });
	const levels: number[] = [];
	const sampleCounts: number[] = [];
	await run({
		command,
		args: noiseScanArgs({ source }),
		signal,
		onLine(line) {
			const parsed = parseNoiseScanLine(line);
			if (parsed && "rmsDb" in parsed) levels.push(parsed.rmsDb);
			if (parsed && "samples" in parsed) sampleCounts.push(parsed.samples);
		},
	});
	// Each window logs both, in order.
	const noiseWindow = pickNoiseWindow(
		levels.map((rmsDb, index) => ({
			rmsDb,
			samples: sampleCounts[index] ?? 0,
		})),
	);
	let profile: NoiseProfile | null = null;
	if (noiseWindow) {
		profile = {
			file: join(dirname(output), "noise-profile.wav"),
			window: noiseWindow,
		};
		await extractNoiseProfile({
			command,
			source,
			window: noiseWindow,
			output: profile.file,
			signal,
		});
	}
	await run({
		command,
		args: denoiseArgs({ source, output, profile }),
		signal,
	});
	return { noiseWindow };
};

export interface DenoisedAudio {
	/** The rendered WAV under Cache/noise-reduction. */
	file: string;
	cached: boolean;
	/** Where the noise profile came from; only known when rendered now. */
	noiseWindow?: NoiseWindow | null;
}

export type NoiseReducer = ReturnType<typeof createNoiseReducer>;

/**
 * Renders noise-reduced copies of Footage audio with FFmpeg, cached under
 * Cache/noise-reduction. Footage is never written.
 */
export function createNoiseReducer({
	root,
	render = renderDenoised,
}: {
	root: string;
	render?: RenderDenoised;
}) {
	const stop = new AbortController();
	const cacheDir = join(root, "Cache", "noise-reduction");
	const renders = createSharedWork<DenoisedAudio>({ stop: stop.signal });

	async function identify(path: string) {
		const { source, info } = await resolveRecording({ root, path });
		const key = denoiseCacheKey({ path, info });
		return { source, key, file: join(cacheDir, `${key}.wav`) };
	}

	async function renderAndCache({
		path,
		source,
		key,
		file,
		signal,
	}: {
		path: string;
		source: string;
		key: string;
		file: string;
		signal: AbortSignal;
	}): Promise<DenoisedAudio> {
		if (await Bun.file(file).exists()) return { file, cached: true };
		await mkdir(cacheDir, { recursive: true });
		const temporary = await mkdtemp(join(cacheDir, ".job-"));
		try {
			const output = join(temporary, "denoised.wav");
			const { noiseWindow } = await render({
				root,
				source,
				output,
				signal,
			}).catch(async (error: unknown) => {
				// The file can leave Footage after it was identified, before FFmpeg
				// opens it: report that as missing Footage, not as FFmpeg's error.
				await resolveRecording({ root, path });
				throw error;
			});
			if ((await identify(path)).key !== key)
				throw new Error("Footage changed while reducing noise. Try again.");
			await rename(output, file);
			return { file, cached: false, noiseWindow };
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	/**
	 * Every request for a file shares one render. `signal` ends this request's
	 * wait, and the render once no request waits for it.
	 */
	async function ensure({
		path,
		signal,
	}: {
		path: string;
		signal?: AbortSignal;
	}): Promise<DenoisedAudio> {
		const identity = await identify(path);
		stop.signal.throwIfAborted();
		return renders.run({
			key: identity.key,
			signal,
			work: (jobSignal) =>
				renderAndCache({ path, ...identity, signal: jobSignal }),
		});
	}

	return {
		ensure,

		/** The `noiseReduction.render` RPC: renders ahead, so playback starts at once. */
		async render({
			params,
			signal,
		}: {
			params: unknown;
			signal?: AbortSignal;
		}) {
			const parsed = renderSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { path } = parsed.data;
			const { cached, noiseWindow } = await ensure({ path, signal });
			return {
				path,
				cached,
				...(noiseWindow !== undefined && {
					noiseProfile: noiseWindow
						? { sampledAt: noiseWindow.start, rmsDb: noiseWindow.rmsDb }
						: "tracked",
				}),
			};
		},

		async stop() {
			stop.abort();
			await renders.settled();
		},
	};
}

/** Whether a media request asks for the noise-reduced audio of the file. */
export function wantsDenoisedAudio(url: URL): boolean {
	return url.searchParams.get("audio") === DENOISED_AUDIO;
}
