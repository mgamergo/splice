import type { ProjectItem } from "@/media/types";
import { buildClipFromMedia } from "@/timeline";
import { VOLUME_DB_MIN } from "@/timeline/audio-constants";
import { getClipVolume } from "@/timeline/audio-state";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import type {
	AudioTrack,
	SequenceTracks,
	UploadAudioClip,
	VideoClip,
	VideoTrack,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export const PICTURE_REPAIR_TRACK_NAME = "Picture repair";
export const REPAIR_SOUNDS_TRACK_NAME = "Repair sounds";
/** A brought-in sound fades this quickly at each end, so it doesn't click. */
const SOUND_EDGE_SECONDS = 0.02;

export class PictureRepairError extends Error {}

export interface PictureRepair {
	trackId: string;
	clip: VideoClip;
}

/** The sequence's picture-only repairs, in sequence order. */
export function pictureRepairs({
	tracks,
}: {
	tracks: SequenceTracks;
}): PictureRepair[] {
	return tracks.overlay
		.flatMap((track) =>
			track.type === "video"
				? track.clips.flatMap((clip) =>
						clip.type === "video" && clip.pictureRepair
							? [{ trackId: track.id, clip }]
							: [],
					)
				: [],
		)
		.sort((a, b) => a.clip.startTime - b.clip.startTime);
}

/** A track named `name` with room for the span, or a new one. */
function trackWithRoom<T extends VideoTrack | AudioTrack>({
	tracks,
	name,
	startTime,
	duration,
	create,
}: {
	tracks: T[];
	name: string;
	startTime: MediaTime;
	duration: MediaTime;
	create: () => T;
}): { track: T; isNew: boolean } {
	const existing = tracks.find(
		(track) =>
			track.name === name &&
			canPlaceTimeSpansOnTrack({ track, timeSpans: [{ startTime, duration }] }),
	);
	return existing ? { track: existing, isNew: false } : { track: create(), isNew: true };
}

/**
 * Shows the replacement take's picture over the narration from `at` for
 * `duration`, starting at `sourceIn` in its recording. The repair goes on a
 * video track just above the main track, with its own audio muted, so the
 * narration underneath carries on.
 */
export function withPictureRepair({
	tracks,
	item,
	at,
	duration,
	sourceIn,
}: {
	tracks: SequenceTracks;
	item: ProjectItem;
	at: MediaTime;
	duration: MediaTime;
	sourceIn: number;
}): { tracks: SequenceTracks; clipId: string } {
	if (item.type !== "video")
		throw new PictureRepairError(
			`${item.name} isn't a video, so it has no picture to repair with.`,
		);
	const itemSeconds = item.duration ?? 0;
	const seconds = mediaTimeToSeconds({ time: duration });
	if (seconds <= 0)
		throw new PictureRepairError("A picture repair needs a duration.");
	// A frame's rounding either way is fine.
	if (sourceIn + seconds > itemSeconds + 0.05)
		throw new PictureRepairError(
			`${item.name} is ${itemSeconds.toFixed(2)} s long, so it can't show ${seconds.toFixed(2)} s from ${sourceIn.toFixed(2)} s.`,
		);
	const sourceDuration = mediaTimeFromSeconds({ seconds: itemSeconds });
	const trimStart = mediaTimeFromSeconds({ seconds: sourceIn });
	const built = buildClipFromMedia({
		mediaId: item.id,
		mediaType: "video",
		name: item.name,
		duration,
		startTime: at,
	});
	if (built.type !== "video")
		throw new PictureRepairError(`${item.name} isn't a video.`);
	const clip: VideoClip = {
		...built,
		id: generateUUID(),
		trimStart,
		trimEnd: roundMediaTime({
			time: Math.max(0, sourceDuration - trimStart - duration),
		}),
		sourceDuration,
		// The narration below keeps playing; the replacement's own sound is muted.
		isSourceAudioEnabled: false,
		pictureRepair: true,
	};
	const videoTracks = tracks.overlay.filter(
		(track): track is VideoTrack => track.type === "video",
	);
	const { track, isNew } = trackWithRoom({
		tracks: videoTracks,
		name: PICTURE_REPAIR_TRACK_NAME,
		startTime: at,
		duration,
		create: () => ({
			id: generateUUID(),
			name: PICTURE_REPAIR_TRACK_NAME,
			type: "video",
			clips: [],
			muted: false,
			hidden: false,
		}),
	});
	const updated: VideoTrack = {
		...track,
		clips: [...track.clips, clip].sort((a, b) => a.startTime - b.startTime),
	};
	return {
		clipId: clip.id,
		tracks: {
			...tracks,
			// The last overlay track sits just above the main track, under any
			// graphics and captions.
			overlay: isNew
				? [...tracks.overlay, updated]
				: tracks.overlay.map((candidate) =>
						candidate.id === updated.id ? updated : candidate,
					),
		},
	};
}

/**
 * Brings one sound in from a picture repair's replacement take: the audio of
 * `start`–`end` (sequence time, inside the repair) plays as its own clip,
 * lined up with the picture, with short fades at its edges.
 */
export function withRepairSound({
	tracks,
	clipId,
	start,
	end,
}: {
	tracks: SequenceTracks;
	clipId: string;
	start: MediaTime;
	end: MediaTime;
}): { tracks: SequenceTracks; clipId: string } {
	const repair = pictureRepairs({ tracks }).find(
		({ clip }) => clip.id === clipId,
	)?.clip;
	if (!repair)
		throw new PictureRepairError(
			`Clip ${clipId} isn't a picture repair. Use the id picture_repair returned.`,
		);
	if (repair.retime && repair.retime.rate !== 1)
		throw new PictureRepairError(
			"This repair plays at another speed, so its sound can't be lined up.",
		);
	const repairEnd = addMediaTime({ a: repair.startTime, b: repair.duration });
	if (end <= start || start < repair.startTime || end > repairEnd)
		throw new PictureRepairError(
			`Pick a stretch inside the repair, ${mediaTimeToSeconds({ time: repair.startTime }).toFixed(2)}–${mediaTimeToSeconds({ time: repairEnd }).toFixed(2)} s.`,
		);
	const duration = roundMediaTime({ time: end - start });
	const trimStart = roundMediaTime({
		time: repair.trimStart + (start - repair.startTime),
	});
	const sourceDuration =
		repair.sourceDuration ??
		roundMediaTime({ time: repair.trimStart + repair.duration + repair.trimEnd });
	const built = buildClipFromMedia({
		mediaId: repair.mediaId,
		mediaType: "audio",
		name: `${repair.name} (sound)`,
		duration,
		startTime: start,
	});
	if (built.type !== "audio" || built.sourceType !== "upload")
		throw new PictureRepairError("Couldn't build the sound's clip.");
	const volume = getClipVolume({ clip: repair });
	const edge = roundMediaTime({
		time: Math.min(
			mediaTimeFromSeconds({ seconds: SOUND_EDGE_SECONDS }),
			Math.floor(duration / 4),
		),
	});
	const key = ({ time, value }: { time: MediaTime; value: number }) => ({
		id: generateUUID(),
		time,
		value,
		segmentToNext: "linear" as const,
		tangentMode: "auto" as const,
	});
	const sound: UploadAudioClip = {
		...built,
		id: generateUUID(),
		trimStart,
		trimEnd: roundMediaTime({
			time: Math.max(0, sourceDuration - trimStart - duration),
		}),
		sourceDuration,
		params: {
			...built.params,
			volume,
			...(repair.params.noiseReduction === true && { noiseReduction: true }),
		},
		animations: {
			volume: {
				keys: [
					key({ time: ZERO_MEDIA_TIME, value: VOLUME_DB_MIN }),
					key({ time: edge, value: volume }),
					key({ time: roundMediaTime({ time: duration - edge }), value: volume }),
					key({ time: duration, value: VOLUME_DB_MIN }),
				],
			},
		},
	};
	const { track, isNew } = trackWithRoom({
		tracks: tracks.audio,
		name: REPAIR_SOUNDS_TRACK_NAME,
		startTime: start,
		duration,
		create: () => ({
			id: generateUUID(),
			name: REPAIR_SOUNDS_TRACK_NAME,
			type: "audio",
			clips: [],
			muted: false,
		}),
	});
	const updated: AudioTrack = {
		...track,
		clips: [...track.clips, sound].sort((a, b) => a.startTime - b.startTime),
	};
	return {
		clipId: sound.id,
		tracks: {
			...tracks,
			audio: isNew
				? [updated, ...tracks.audio]
				: tracks.audio.map((candidate) =>
						candidate.id === updated.id ? updated : candidate,
					),
		},
	};
}
