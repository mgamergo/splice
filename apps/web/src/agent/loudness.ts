import {
	type AudioSource,
	type SourceGain,
	sortSourceRanges,
} from "@splice/bridge/ops";
import { isDiskMedia } from "@/media/media-data";
import type { ProjectItem } from "@/media/types";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	canClipHaveAudio,
	canTrackHaveAudio,
	doesClipHaveEnabledAudio,
	hasMediaId,
	isRetimableClip,
	type AudioClip,
	type SequenceTracks,
	type TimelineClip,
	type VideoClip,
	updateClipInSequenceTracks,
} from "@/timeline";
import {
	hasAnimatedVolume,
	isClipMuted,
	isNoiseReduced,
} from "@/timeline/audio-state";
import { addMediaTime, mediaTimeToSeconds, roundMediaTime } from "@/wasm";

export class LoudnessError extends Error {}

export function formatGain(gainDb: number): string {
	return `${gainDb > 0 ? "+" : ""}${gainDb.toFixed(1)} dB`;
}

export type AudibleClip = Extract<AudioClip | VideoClip, { mediaId: string }>;

/** Clips whose project item audio reaches playback and export, in track order. */
export function audibleClips({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): Array<{ trackId: string; clip: AudibleClip }> {
	const items = new Map(projectItems.map((item) => [item.id, item]));
	return [tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) => {
		if (canTrackHaveAudio(track) && track.muted) return [];
		return track.clips
			.filter(
				(clip: TimelineClip): clip is AudibleClip =>
					canClipHaveAudio(clip) &&
					hasMediaId(clip) &&
					!isClipMuted({ clip }) &&
					doesClipHaveEnabledAudio({
						clip,
						projectItem: items.get(clip.mediaId),
					}),
			)
			.map((clip) => ({ trackId: track.id, clip }));
	});
}

/**
 * Each project item's audible source ranges in a sequence, one per clip, for
 * measuring loudness. Clips of one item with noise reduction on and off are
 * separate sources, since they sound different. Missing items are listed, so
 * the report can say they were skipped.
 */
export function collectAudioSources({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): AudioSource[] {
	const sources = new Map<string, AudioSource>();
	for (const { clip } of audibleClips({ tracks, projectItems })) {
		const span = roundMediaTime({
			time: getSourceSpanAtClipTime({
				clipTime: clip.duration,
				retime: isRetimableClip(clip) ? clip.retime : undefined,
			}),
		});
		if (span <= 0) continue;
		const item = projectItems.find(({ id }) => id === clip.mediaId);
		const path = item && isDiskMedia(item.file) ? item.file.path : null;
		// Browser-stored items have no noise-reduced render to play.
		const noiseReduction = path !== null && isNoiseReduced({ clip });
		const key = `${clip.mediaId}:${noiseReduction}`;
		let source = sources.get(key);
		if (!source) {
			source = {
				projectItemId: clip.mediaId,
				path,
				noiseReduction,
				missing: item?.missing === true,
				clipIds: [],
				ranges: [],
			};
			sources.set(key, source);
		}
		source.clipIds.push(clip.id);
		source.ranges.push({
			start: mediaTimeToSeconds({ time: clip.trimStart }),
			end: mediaTimeToSeconds({
				time: addMediaTime({ a: clip.trimStart, b: span }),
			}),
		});
	}
	return Array.from(sources.values(), (source) => ({
		...source,
		ranges: sortSourceRanges(source.ranges),
	}));
}

/**
 * Sets the volume of every audible clip of each listed project item. Gains are
 * absolute, since they come from measuring the source itself.
 */
export function applySourceGains({
	tracks,
	projectItems,
	gains,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	gains: SourceGain[];
}): SequenceTracks {
	const byItem = new Map(
		gains.map((gain) => [gain.projectItemId, gain.gainDb]),
	);
	let updated = tracks;
	for (const { trackId, clip } of audibleClips({ tracks, projectItems })) {
		const volume = byItem.get(clip.mediaId);
		if (volume === undefined) continue;
		if (hasAnimatedVolume({ clip }))
			throw new LoudnessError(
				`Clip ${clip.id} has volume keyframes, which a gain would not override. Remove them or skip loudness.`,
			);
		updated = updateClipInSequenceTracks({
			tracks: updated,
			trackId,
			clipId: clip.id,
			update: (current) => ({
				...current,
				params: { ...current.params, volume },
			}),
		});
	}
	return updated;
}
