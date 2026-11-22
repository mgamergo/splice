import type { SequenceTracks, TimelineClip, VideoTrack } from "@/timeline";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export const MAIN_TRACK_NAME = "Main Track";

export function getEarliestMainTrackClip({
	mainTrack,
	excludeClipId,
}: {
	mainTrack: VideoTrack;
	excludeClipId?: string;
}): TimelineClip | null {
	const clips = mainTrack.clips.filter((clip) => {
		return !excludeClipId || clip.id !== excludeClipId;
	});
	if (clips.length === 0) {
		return null;
	}

	return clips.reduce((earliestClip, clip) => {
		return clip.startTime < earliestClip.startTime
			? clip
			: earliestClip;
	});
}

export function enforceMainTrackStart({
	tracks,
	targetTrackId,
	requestedStartTime,
	excludeClipId,
}: {
	tracks: SequenceTracks;
	targetTrackId: string;
	requestedStartTime: MediaTime;
	excludeClipId?: string;
}): MediaTime {
	if (tracks.main.id !== targetTrackId) {
		return requestedStartTime;
	}

	const earliestClip = getEarliestMainTrackClip({
		mainTrack: tracks.main,
		excludeClipId,
	});
	if (!earliestClip) {
		return ZERO_MEDIA_TIME;
	}

	if (requestedStartTime <= earliestClip.startTime) {
		return ZERO_MEDIA_TIME;
	}

	return requestedStartTime;
}
