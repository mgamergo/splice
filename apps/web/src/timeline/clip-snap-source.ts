import type { SequenceTracks } from "@/timeline";
import type { SnapPoint } from "@/timeline/snapping";
import { addMediaTime } from "@/wasm";

export function getClipEdgeSnapPoints({
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

			snapPoints.push(
				{
					time: clip.startTime,
					type: "clip-start",
					clipId: clip.id,
					trackId: track.id,
				},
				{
					time: addMediaTime({ a: clip.startTime, b: clip.duration }),
					type: "clip-end",
					clipId: clip.id,
					trackId: track.id,
				},
			);
		}
	}

	return snapPoints;
}
