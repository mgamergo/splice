import { getClipKeyframes } from "@/animation";
import type { SequenceTracks } from "@/timeline";
import type { SnapPoint } from "@/timeline/snapping";
import { addMediaTime } from "@/wasm";

export function getAnimationKeyframeSnapPointsForTimeline({
	tracks,
	excludeClipIds,
}: {
	tracks: SequenceTracks;
	excludeClipIds?: Set<string>;
}): SnapPoint[] {
	const snapPoints: SnapPoint[] = [];
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];

	for (const track of orderedTracks) {
		for (const clip of track.clips) {
			if (excludeClipIds?.has(clip.id)) {
				continue;
			}

			for (const keyframe of getClipKeyframes({
				animations: clip.animations,
			})) {
				snapPoints.push({
					time: addMediaTime({ a: clip.startTime, b: keyframe.time }),
					type: "keyframe",
					clipId: clip.id,
					trackId: track.id,
				});
			}
		}
	}

	return snapPoints;
}
