import { DENOISED_AUDIO } from "@splice/bridge";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	ffmpegInput,
	ffmpegInputArgs,
	findFfmpeg,
	run,
	SOURCE_TIMELINE_FILTER,
} from "./transcription-tools";
import { footagePath, invalidParams, resolveRecording } from "./transcription";

export const renderNoiseReductionInput = { path: footagePath };
const renderSchema = z.object(renderNoiseReductionInput);

/** Bump when the filters change, so earlier renders aren't reused. */
export const NOISE_REDUCTION_VERSION = 1;
/** Length of the quiet stretch the noise profile is learned from. */
export const NOISE_WINDOW_SECONDS = 1;
/** The quietest window counts as noise only this far below the loud windows. */
const MIN_NOISE_CONTRAST_DB = 15;
/** Quieter windows are digital silence (a muted mic), with no noise to learn. */
const DIGITAL_SILENCE_DB = -90;
const SCAN_SAMPLE_RATE = 48_000;

/**
 * A 4-pole high-pass at 80 Hz, below the voice: removes mains hum
 * fundamentals and rumble, which afftdn's coarse bands leave behind.
 */
const RUMBLE_FILTER = "highpass=f=80:poles=2,highpass=f=80:poles=2";
/** Up to 20 dB of reduction, from a profile sampled in a quiet stretch. */
const SAMPLED_DENOISE_FILTER = "afftdn=nr=20:nf=-50";
/** Without a quiet stretch, afftdn tracks the floor itself, more gently. */
const TRACKED_DENOISE_FILTER = "afftdn=nr=12:nf=-50:tn=1";

/** A quiet stretch of a recording, in source seconds. */
export interface NoiseWindow {
	start: number;
	rmsDb: number;
}

export function denoiseCacheKey({
	path,
	size,
	mtimeMs,
}: {
	path: string;
	size: number;
	mtimeMs: number;
}): string {
	return createHash("sha256")
		.update(JSON.stringify([NOISE_REDUCTION_VERSION, path, size, mtimeMs]))
		.digest("hex");
}

function seconds(value: number): string {
	return value.toFixed(6);
}

/** Logs the RMS level of each window of the recording, in order. */
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
			`aresample=${SCAN_SAMPLE_RATE}:async=1:first_pts=0`,
			`asetnsamples=n=${SCAN_SAMPLE_RATE * NOISE_WINDOW_SECONDS}:p=0`,
			"astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level",
			"ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
		].join(","),
		"-f",
		"null",
		"-",
	];
}

const RMS_LINE = /lavfi\.astats\.Overall\.RMS_level=(-inf|-?\d+(?:\.\d+)?)/;

/** The window level in a line of `noiseScanArgs` output, if it holds one. */
export function parseNoiseScanLine(line: string): number | null {
	const match = RMS_LINE.exec(line)?.[1];
	if (match === undefined) return null;
	return match === "-inf" ? -Infinity : Number(match);
}

/**
 * The quietest window that still holds noise, or null when no window is
 * clearly quieter than the speech (nothing but talking, or too short).
 */
export function pickNoiseWindow(levels: number[]): NoiseWindow | null {
	// The last window can be partial.
	const windows = levels
		.slice(0, -1)
		.map((rmsDb, index) => ({ start: index * NOISE_WINDOW_SECONDS, rmsDb }))
		.filter(({ rmsDb }) => rmsDb > DIGITAL_SILENCE_DB);
	if (windows.length < 2) return null;
	const sorted = windows.map(({ rmsDb }) => rmsDb).sort((a, b) => a - b);
	const loud = sorted[Math.floor((sorted.length - 1) * 0.9)];
	const quietest = windows.reduce((best, window) =>
		window.rmsDb < best.rmsDb ? window : best,
	);
	return loud - quietest.rmsDb >= MIN_NOISE_CONTRAST_DB ? quietest : null;
}

/**
 * Renders the recording's first audio stream with noise reduction as WAV, on
 * the source timeline. With a noise window, the window is played in first so
 * afftdn learns its profile there, and is then cut off.
 */
export function denoiseArgs({
	source,
	output,
	window,
}: {
	source: string;
	output: string;
	window: NoiseWindow | null;
}): string[] {
	const head = ["-nostdin", "-hide_banner", "-loglevel", "error", "-nostats"];
	const tail = ["-c:a", "pcm_s16le", "-f", "wav", "-y", output];
	if (!window)
		return [
			...head,
			...ffmpegInputArgs({ source }),
			"-map",
			"0:a:0",
			"-af",
			[SOURCE_TIMELINE_FILTER, RUMBLE_FILTER, TRACKED_DENOISE_FILTER].join(","),
			...tail,
		];
	const length = seconds(NOISE_WINDOW_SECONDS);
	return [
		...head,
		// A second demuxer reads the window, so the whole file never buffers.
		"-ss",
		seconds(window.start),
		...ffmpegInput({ source }),
		...ffmpegInput({ source }),
		"-filter_complex",
		[
			`[0:a:0]atrim=duration=${length},asetpts=PTS-STARTPTS[noise]`,
			`[1:a:0]${SOURCE_TIMELINE_FILTER}[recording]`,
			[
				"[noise][recording]concat=n=2:v=0:a=1",
				RUMBLE_FILTER,
				`asendcmd=c='0 afftdn sn start;${length} afftdn sn stop'`,
				SAMPLED_DENOISE_FILTER,
				`atrim=start=${length}`,
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
	await run({
		command,
		args: noiseScanArgs({ source }),
		signal,
		onLine(line) {
			const level = parseNoiseScanLine(line);
			if (level !== null) levels.push(level);
		},
	});
	const noiseWindow = pickNoiseWindow(levels);
	await run({
		command,
		args: denoiseArgs({ source, output, window: noiseWindow }),
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
	const signal = stop.signal;
	const cacheDir = join(root, "Cache", "noise-reduction");
	const active = new Map<string, Promise<DenoisedAudio>>();

	async function identify(path: string) {
		const { source, info } = await resolveRecording({ root, path });
		const key = denoiseCacheKey({
			path,
			size: info.size,
			mtimeMs: info.mtimeMs,
		});
		return { source, key, file: join(cacheDir, `${key}.wav`) };
	}

	async function renderAndCache({
		path,
		source,
		key,
		file,
	}: {
		path: string;
		source: string;
		key: string;
		file: string;
	}): Promise<DenoisedAudio> {
		if (await Bun.file(file).exists()) return { file, cached: true };
		await mkdir(cacheDir, { recursive: true });
		const temporary = await mkdtemp(join(cacheDir, ".job-"));
		try {
			const output = join(temporary, "denoised.wav");
			const { noiseWindow } = await render({ root, source, output, signal });
			if ((await identify(path)).key !== key)
				throw new Error("Footage changed while reducing noise. Try again.");
			await rename(output, file);
			return { file, cached: false, noiseWindow };
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	async function ensure({ path }: { path: string }): Promise<DenoisedAudio> {
		const identity = await identify(path);
		signal.throwIfAborted();
		let pending = active.get(identity.key);
		if (!pending) {
			pending = renderAndCache({ path, ...identity });
			active.set(identity.key, pending);
			void pending
				.catch(() => undefined)
				.finally(() => active.delete(identity.key));
		}
		return pending;
	}

	return {
		ensure,

		/** The `noiseReduction.render` RPC: renders ahead, so playback starts at once. */
		async render(params: unknown) {
			const parsed = renderSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { path } = parsed.data;
			const { cached, noiseWindow } = await ensure({ path });
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
			await Promise.allSettled(active.values());
		},
	};
}

/** Whether a media request asks for the noise-reduced audio of the file. */
export function wantsDenoisedAudio(url: URL): boolean {
	return url.searchParams.get("audio") === DENOISED_AUDIO;
}
