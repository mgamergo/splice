import type { ClipType, TrackType } from "@/timeline";

const CLIP_TRACK_MAP: Record<ClipType, TrackType> = {
	audio: "audio",
	text: "text",
	sticker: "graphic",
	graphic: "graphic",
	effect: "effect",
	video: "video",
	image: "video",
};

export function getTrackTypeForClipType({
	clipType,
}: {
	clipType: ClipType;
}): TrackType {
	return CLIP_TRACK_MAP[clipType];
}

export function canClipGoOnTrack({
	clipType,
	trackType,
}: {
	clipType: ClipType;
	trackType: TrackType;
}): boolean {
	return getTrackTypeForClipType({ clipType }) === trackType;
}

export function validateClipTrackCompatibility({
	clip,
	track,
}: {
	clip: { type: ClipType };
	track: { type: TrackType };
}): { isValid: boolean; errorMessage?: string } {
	const isValid = canClipGoOnTrack({
		clipType: clip.type,
		trackType: track.type,
	});

	if (!isValid) {
		return {
			isValid: false,
			errorMessage: `${clip.type} clips cannot be placed on ${track.type} tracks`,
		};
	}

	return { isValid: true };
}
