import type {
	AudioTrack,
	EffectTrack,
	GraphicTrack,
	OverlayTrack,
	SequenceTracks,
	TextTrack,
	TimelineClip,
	TimelineTrack,
	VideoTrack,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { buildEmptyTrack } from "./track-factory";
import type { PlacementResult } from "./types";
import { updateTrackInSequenceTracks } from "@/timeline/track-clip-update";

export function applyPlacement({
	tracks,
	placementResult,
	clips,
	newTrackInsertIndexOverride,
}: {
	tracks: SequenceTracks;
	placementResult: PlacementResult;
	clips: TimelineClip[];
	newTrackInsertIndexOverride?: number;
}): { updatedTracks: SequenceTracks; targetTrackId: string } | null {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	if (placementResult.kind === "existingTrack") {
		const targetTrack = orderedTracks[placementResult.trackIndex];
		if (!targetTrack) {
			return null;
		}

		const updatedTracks = updateTrackInSequenceTracks({
			tracks,
			trackId: targetTrack.id,
			update: (track) => ({
				...track,
				clips: [...track.clips, ...clips],
			}),
		});

		return { updatedTracks, targetTrackId: targetTrack.id };
	}

	const newTrackId = generateUUID();
	const insertIndex =
		newTrackInsertIndexOverride ?? placementResult.insertIndex;
	const updatedTracks =
		placementResult.trackType === "audio"
			? {
					...tracks,
					audio: insertIntoAudioTracks({
						tracks,
						insertIndex,
						track: buildPlacedAudioTrack({
							id: newTrackId,
							clips,
						}),
					}),
				}
			: {
					...tracks,
					overlay: insertIntoOverlayTracks({
						tracks,
						insertIndex,
						track: buildPlacedOverlayTrack({
							id: newTrackId,
							type: placementResult.trackType,
							clips,
						}),
					}),
				};
	return { updatedTracks, targetTrackId: newTrackId };
}

function insertIntoOverlayTracks({
	tracks,
	insertIndex,
	track,
}: {
	tracks: SequenceTracks;
	insertIndex: number;
	track: OverlayTrack;
}): OverlayTrack[] {
	const normalizedInsertIndex = Math.max(
		0,
		Math.min(insertIndex, tracks.overlay.length),
	);
	const nextTracks = [...tracks.overlay];
	nextTracks.splice(normalizedInsertIndex, 0, track);
	return nextTracks;
}

function insertIntoAudioTracks({
	tracks,
	insertIndex,
	track,
}: {
	tracks: SequenceTracks;
	insertIndex: number;
	track: AudioTrack;
}): AudioTrack[] {
	const audioInsertIndex = Math.max(
		0,
		Math.min(insertIndex - tracks.overlay.length - 1, tracks.audio.length),
	);
	const nextTracks = [...tracks.audio];
	nextTracks.splice(audioInsertIndex, 0, track);
	return nextTracks;
}

function buildPlacedAudioTrack({
	id,
	clips,
}: {
	id: string;
	clips: TimelineClip[];
}): AudioTrack {
	return {
		...buildEmptyTrack({ id, type: "audio" }),
		clips: clips as AudioTrack["clips"],
	};
}

function buildPlacedOverlayTrack({
	id,
	type,
	clips,
}: {
	id: string;
	type: Exclude<OverlayTrack["type"], "audio">;
	clips: TimelineClip[];
}): OverlayTrack {
	switch (type) {
		case "video":
			return {
				...buildEmptyTrack({ id, type: "video" }),
				clips: clips as VideoTrack["clips"],
			};
		case "text":
			return {
				...buildEmptyTrack({ id, type: "text" }),
				clips: clips as TextTrack["clips"],
			};
		case "graphic":
			return {
				...buildEmptyTrack({ id, type: "graphic" }),
				clips: clips as GraphicTrack["clips"],
			};
		case "effect":
			return {
				...buildEmptyTrack({ id, type: "effect" }),
				clips: clips as EffectTrack["clips"],
			};
	}
}
