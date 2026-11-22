import type { TimelineClip } from "@/timeline";
import type { PlacementTimeSpan } from "./types";

interface TrackWithClips {
	clips: TimelineClip[];
}

function wouldClipOverlap({
	clips,
	startTime,
	endTime,
	excludeClipId,
}: {
	clips: TimelineClip[];
	startTime: number;
	endTime: number;
	excludeClipId?: string;
}): boolean {
	return clips.some((clip) => {
		if (excludeClipId && clip.id === excludeClipId) {
			return false;
		}

		const clipEnd = clip.startTime + clip.duration;
		return startTime < clipEnd && endTime > clip.startTime;
	});
}

export function canPlaceTimeSpansOnTrack({
	track,
	timeSpans,
}: {
	track: TrackWithClips;
	timeSpans: PlacementTimeSpan[];
}): boolean {
	return timeSpans.every(({ startTime, duration, excludeClipId }) => {
		return !wouldClipOverlap({
			clips: track.clips,
			startTime,
			endTime: startTime + duration,
			excludeClipId,
		});
	});
}
