import { addMediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import type { SequenceTracks } from "./types";

export * from "./types";
export * from "./drag";
export * from "./track-capabilities";
export * from "./track-clip-update";
export * from "./clip-utils";
export * from "./audio-separation";
export * from "./zoom-utils";
export * from "./ruler-utils";
export * from "./pixel-utils";

export function calculateTotalDuration({
	tracks,
}: {
	tracks: SequenceTracks;
}): MediaTime {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	if (orderedTracks.length === 0) return ZERO_MEDIA_TIME;

	let maxEnd: MediaTime = ZERO_MEDIA_TIME;
	for (const track of orderedTracks) {
		for (const clip of track.clips) {
			if (clip.type === "text" && clip.shortHook?.unavailable) continue;
			const clipEnd = addMediaTime({
				a: clip.startTime,
				b: clip.duration,
			});
			if (clipEnd > maxEnd) maxEnd = clipEnd;
		}
	}
	return maxEnd;
}
