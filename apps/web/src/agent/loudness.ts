import {
	type AudioSource,
	type SourceGain,
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
import { hasAnimatedVolume, isClipMuted } from "@/timeline/audio-state";
import { addMediaTime, mediaTimeToSeconds, roundMediaTime } from "@/wasm";

export class LoudnessError extends Error {}

export function formatGain(gainDb: number): string {
	return `${gainDb > 0 ? "+" : ""}${gainDb.toFixed(1)} dB`;
}

type AudibleClip = Extract<AudioClip | VideoClip, { mediaId: string }>;

/** Clips whose project item audio reaches playback and export, in track order. */
function audibleClips({
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
 * measuring loudness. Missing items are listed, so the report can say they
 * were skipped.
 */
export function collectAudioSources({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): AudioSource[] {
	const sources = new Map<string, AudioSource>();
	// In the order they play, so the meter hears the joins between them.
	const played = [...audibleClips({ tracks, projectItems })].sort(
		(a, b) => a.clip.startTime - b.clip.startTime,
	);
	for (const { clip } of played) {
		const span = roundMediaTime({
			time: getSourceSpanAtClipTime({
				clipTime: clip.duration,
				retime: isRetimableClip(clip) ? clip.retime : undefined,
			}),
		});
		if (span <= 0) continue;
		let source = sources.get(clip.mediaId);
		if (!source) {
			const item = projectItems.find(({ id }) => id === clip.mediaId);
			source = {
				projectItemId: clip.mediaId,
				path: item && isDiskMedia(item.file) ? item.file.path : null,
				missing: item?.missing === true,
				clipIds: [],
				ranges: [],
			};
			sources.set(clip.mediaId, source);
		}
		source.clipIds.push(clip.id);
		source.ranges.push({
			start: mediaTimeToSeconds({ time: clip.trimStart }),
			end: mediaTimeToSeconds({
				time: addMediaTime({ a: clip.trimStart, b: span }),
			}),
		});
	}
	return [...sources.values()];
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
