import { hasKeyframesForPath } from "@/animation/keyframe-query";
import { resolveNumberAtTime } from "@/animation/values";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "./audio-constants";
import type { TimelineClip } from "./types";
const DEFAULT_STEP_SECONDS = 1 / 60;

export type AudioCapableClip = Extract<
	TimelineClip,
	{ type: "audio" | "video" }
>;

export function clampDb(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.min(VOLUME_DB_MAX, Math.max(VOLUME_DB_MIN, value));
}

export function dBToLinear(db: number): number {
	return 10 ** (clampDb(db) / 20);
}

export function getClipVolume({
	clip,
}: {
	clip: AudioCapableClip;
}): number {
	const value = clip.params.volume;
	return typeof value === "number" ? value : 0;
}

export function isClipMuted({
	clip,
}: {
	clip: AudioCapableClip;
}): boolean {
	return clip.params.muted === true;
}

/** Whether the clip plays its recording's noise-reduced render. Off by default. */
export function isNoiseReduced({
	clip,
}: {
	clip: AudioCapableClip;
}): boolean {
	return clip.params.noiseReduction === true;
}

export function hasAnimatedVolume({
	clip,
}: {
	clip: AudioCapableClip;
}): boolean {
	return (
		(clip.type === "audio" && !!clip.musicDucking?.keys.length) ||
		hasKeyframesForPath({
			animations: clip.animations,
			propertyPath: "volume",
		})
	);
}

import { TICKS_PER_SECOND } from "@/wasm";

export function resolveEffectiveAudioGain({
	clip,
	trackMuted = false,
	localTime,
}: {
	clip: AudioCapableClip;
	trackMuted?: boolean;
	localTime: number;
}): number {
	if (trackMuted || isClipMuted({ clip })) {
		return 0;
	}

	const resolvedDb = resolveNumberAtTime({
		baseValue: getClipVolume({ clip }),
		animations: clip.animations,
		propertyPath: "volume",
		localTime: Math.round(localTime * TICKS_PER_SECOND),
	});

	const duckDb =
		clip.type === "audio" && clip.musicDucking
			? resolveNumberAtTime({
					baseValue: 0,
					animations: { volume: clip.musicDucking },
					propertyPath: "volume",
					localTime: Math.round(localTime * TICKS_PER_SECOND),
				})
			: 0;
	return dBToLinear(resolvedDb + duckDb);
}

export function buildWaveformGainSamples({
	clip,
	count,
}: {
	clip: AudioCapableClip;
	count: number;
}): number[] {
	const durationSeconds = clip.duration / TICKS_PER_SECOND;
	return Array.from({ length: count }, (_, i) => {
		const localTime = ((i + 0.5) / count) * durationSeconds;
		return resolveEffectiveAudioGain({ clip, localTime });
	});
}

export function buildAudioGainAutomation({
	clip,
	trackMuted = false,
	fromLocalTime,
	toLocalTime,
	stepSeconds = DEFAULT_STEP_SECONDS,
}: {
	clip: AudioCapableClip;
	trackMuted?: boolean;
	fromLocalTime: number;
	toLocalTime: number;
	stepSeconds?: number;
}): Array<{ localTime: number; gain: number }> {
	const startTime = Math.max(0, fromLocalTime);
	const endTime = Math.max(startTime, toLocalTime);
	const safeStep =
		Number.isFinite(stepSeconds) && stepSeconds > 0
			? stepSeconds
			: DEFAULT_STEP_SECONDS;
	const points: Array<{ localTime: number; gain: number }> = [];

	for (let localTime = startTime; localTime < endTime; localTime += safeStep) {
		points.push({
			localTime,
			gain: resolveEffectiveAudioGain({
				clip,
				trackMuted,
				localTime,
			}),
		});
	}

	points.push({
		localTime: endTime,
		gain: resolveEffectiveAudioGain({
			clip,
			trackMuted,
			localTime: endTime,
		}),
	});

	return points;
}
