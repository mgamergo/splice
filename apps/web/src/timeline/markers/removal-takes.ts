import type { TakeSourceRange } from "@splice/bridge/ops";
import type { ProjectItem } from "@/media/types";
import { getClipTimeAtSourceTime, getSourceSpanAtClipTime } from "@/retime";
import { buildSeparatedAudioClip } from "@/timeline/audio-separation";
import { buildClipFromMedia } from "@/timeline/clip-utils";
import { razorClip } from "@/timeline/razor";
import type {
	AudioClip,
	RemovalMarker,
	SequenceTracks,
	TimelineClip,
	TimelineTrack,
	VideoClip,
} from "@/timeline/types";
import { buildEmptyTrack } from "@/timeline/placement";
import { generateUUID } from "@/utils/id";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	roundMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export class RemovalTakeError extends Error {}

export function resolveTake({
	take,
	projectItems,
}: {
	take: TakeSourceRange;
	projectItems: ProjectItem[];
}) {
	const item = projectItems.find(({ id }) => id === take.projectItemId);
	if (!item || item.missing || item.type === "image" || !item.duration) {
		throw new RemovalTakeError(
			`Take source ${take.projectItemId} is unavailable.`,
		);
	}
	if (take.sourceOut > item.duration) {
		throw new RemovalTakeError(
			`Take range is outside the source “${item.name}”.`,
		);
	}
	const sourceIn = mediaTimeFromSeconds({ seconds: take.sourceIn });
	const sourceOut = mediaTimeFromSeconds({ seconds: take.sourceOut });
	if (sourceOut <= sourceIn) {
		throw new RemovalTakeError("Take range is too short.");
	}
	return { item, sourceIn, sourceOut };
}

type ResolvedTake = ReturnType<typeof resolveTake>;

function createTakeClip({
	take,
	at,
}: {
	take: ResolvedTake;
	at: MediaTime;
}): VideoClip | AudioClip {
	const sourceDuration = mediaTimeFromSeconds({
		seconds: take.item.duration ?? 0,
	});
	const clip = buildClipFromMedia({
		mediaId: take.item.id,
		mediaType: take.item.type,
		name: take.item.name,
		duration: sourceDuration,
		startTime: at,
	});
	if (clip.type !== "video" && clip.type !== "audio") {
		throw new RemovalTakeError("Takes require a video or audio source.");
	}
	return {
		...clip,
		id: generateUUID(),
		duration: roundMediaTime({ time: take.sourceOut - take.sourceIn }),
		trimStart: take.sourceIn,
		trimEnd: roundMediaTime({ time: sourceDuration - take.sourceOut }),
	};
}

type TakeWindow = {
	start: MediaTime;
	end: MediaTime;
	sourceOut: number;
	trackId: string;
	separated: boolean;
};

function findTakeWindows({
	track,
	take,
}: {
	track: TimelineTrack;
	take: ResolvedTake;
}): TakeWindow[] {
	const windows: TakeWindow[] = [];
	for (const clip of [...track.clips].sort(
		(a, b) => a.startTime - b.startTime,
	)) {
		if (
			(clip.type !== "video" && clip.type !== "audio") ||
			!("mediaId" in clip) ||
			clip.mediaId !== take.item.id
		)
			continue;

		const sourceIn = Math.max(clip.trimStart, take.sourceIn);
		const sourceOut = Math.min(
			clip.trimStart +
				roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: clip.duration,
						retime: clip.retime,
					}),
				}),
			take.sourceOut,
		);
		if (sourceIn >= sourceOut) continue;

		const toTimeline = (sourceTime: number) =>
			roundMediaTime({
				time:
					clip.startTime +
					getClipTimeAtSourceTime({
						sourceTime: sourceTime - clip.trimStart,
						retime: clip.retime,
					}),
			});
		const start = toTimeline(sourceIn);
		const end = toTimeline(sourceOut);
		if (end <= start) continue;

		const separated =
			clip.type === "video" && clip.isSourceAudioEnabled === false;
		const previous = windows.at(-1);
		if (
			previous &&
			previous.end === start &&
			previous.sourceOut <= sourceIn &&
			previous.separated === separated
		) {
			previous.end = end;
			previous.sourceOut = sourceOut;
		} else {
			windows.push({ start, end, sourceOut, trackId: track.id, separated });
		}
	}
	return windows;
}

function mapTracks({
	tracks,
	map,
}: {
	tracks: SequenceTracks;
	map: <Clip extends TimelineClip>(clips: Clip[], trackId: string) => Clip[];
}): SequenceTracks {
	const apply = <Track extends { clips: TimelineClip[]; id: string }>(
		track: Track,
	): Track => ({
		...track,
		clips: map(track.clips, track.id),
	});
	return {
		main: apply(tracks.main),
		overlay: tracks.overlay.map(apply),
		audio: tracks.audio.map(apply),
	};
}

/** Remove the window, splitting just the clips that cross its edges. */
function spliceClips<Clip extends TimelineClip>({
	clips,
	start,
	end,
	delta,
}: {
	clips: Clip[];
	start: MediaTime;
	end: MediaTime;
	delta: number;
}): Clip[] {
	return clips.flatMap((clip) => {
		const clipEnd = clip.startTime + clip.duration;
		if (clipEnd <= start) return [clip];
		if (clip.startTime >= end) {
			return [
				{
					...clip,
					startTime: roundMediaTime({ time: clip.startTime + delta }),
				},
			];
		}
		const left = razorClip({ clip, at: start, rightClipId: clip.id })?.left;
		const right = razorClip({
			clip,
			at: end,
			rightClipId: left ? generateUUID() : clip.id,
		})?.right;
		return [
			...(left ? [left] : []),
			...(right
				? [{ ...right, startTime: roundMediaTime({ time: end + delta }) }]
				: []),
		];
	});
}

function insertTakeClips({
	tracks,
	video,
	audio,
	videoTrackId,
	audioTrackId,
}: {
	tracks: SequenceTracks;
	video: VideoClip[];
	audio: AudioClip[];
	videoTrackId: string;
	audioTrackId?: string;
}): SequenceTracks {
	const ordered = <Clip extends TimelineClip>(clips: Clip[]) =>
		clips.sort((a, b) => a.startTime - b.startTime);
	const audioTrack =
		audio.length > 0 && !audioTrackId
			? buildEmptyTrack({ id: generateUUID(), type: "audio" })
			: null;
	return {
		main:
			tracks.main.id === videoTrackId && video.length
				? { ...tracks.main, clips: ordered([...tracks.main.clips, ...video]) }
				: tracks.main,
		overlay: tracks.overlay.map((track) =>
			track.type === "video" && track.id === videoTrackId && video.length
				? { ...track, clips: ordered([...track.clips, ...video]) }
				: track,
		),
		audio: [
			...tracks.audio.map((track) =>
				track.id === audioTrackId && audio.length
					? { ...track, clips: ordered([...track.clips, ...audio]) }
					: track,
			),
			...(audioTrack ? [{ ...audioTrack, clips: audio }] : []),
		],
	};
}

export function restoreTakeClips({
	tracks,
	takes,
	at,
}: {
	tracks: SequenceTracks;
	takes: ResolvedTake[];
	at: MediaTime;
}) {
	const video: VideoClip[] = [];
	const audio: AudioClip[] = [];
	let end = at;
	for (const take of takes) {
		const clip = createTakeClip({ take, at: end });
		if (clip.type === "video") video.push(clip);
		else audio.push(clip);
		end = roundMediaTime({ time: end + clip.duration });
	}
	const delta = end - at;
	const shifted = mapTracks({
		tracks,
		map: (clips) => spliceClips({ clips, start: at, end: at, delta }),
	});
	return {
		tracks: insertTakeClips({
			tracks: shifted,
			video,
			audio,
			videoTrackId: tracks.main.id,
			audioTrackId: tracks.audio[0]?.id,
		}),
		delta,
	};
}

export function swapTakeClips({
	tracks,
	marker,
	best,
	chosen,
}: {
	tracks: SequenceTracks;
	marker: RemovalMarker;
	best: ResolvedTake;
	chosen: ResolvedTake;
}) {
	if (best.item.type !== chosen.item.type) {
		throw new RemovalTakeError("Swap requires takes of the same media type.");
	}
	const videoTracks = [
		tracks.main,
		...tracks.overlay.filter((track) => track.type === "video"),
	];
	const takeTracks = best.item.type === "video" ? videoTracks : tracks.audio;
	const distance = ({ start, end }: TakeWindow) =>
		Math.max(start - marker.time, marker.time - end, 0);
	const [bestWindow, alternative] = takeTracks
		.flatMap((track) => findTakeWindows({ track, take: best }))
		.sort((a, b) => distance(a) - distance(b));
	if (
		!bestWindow ||
		(alternative && distance(bestWindow) === distance(alternative))
	) {
		throw new RemovalTakeError(
			"Could not identify the best take near this marker.",
		);
	}

	const { start, end, trackId, separated } = bestWindow;
	const separatedTrack = separated
		? tracks.audio.find((track) =>
				findTakeWindows({ track, take: best }).some(
					(window) => window.start === start && window.end === end,
				),
			)
		: undefined;
	const replacement = createTakeClip({ take: chosen, at: start });
	const delta = replacement.duration - (end - start);
	const shifted = mapTracks({
		tracks,
		map: (clips, id) => {
			if (id === trackId || id === separatedTrack?.id) {
				return spliceClips({ clips, start, end, delta });
			}
			// Keep unrelated clips crossing the edit. When shrinking, stop the
			// following clips at that material's end to avoid an overlap.
			const precedingEnd = clips.reduce<number>(
				(latest, clip) =>
					clip.startTime < end
						? Math.max(latest, clip.startTime + clip.duration)
						: latest,
				ZERO_MEDIA_TIME,
			);
			const firstFollowing = clips.reduce(
				(earliest, clip) =>
					clip.startTime >= end ? Math.min(earliest, clip.startTime) : earliest,
				Infinity,
			);
			const shift = Math.max(delta, precedingEnd - firstFollowing);
			return clips.map((clip) =>
				clip.startTime < end
					? clip
					: {
							...clip,
							startTime: roundMediaTime({ time: clip.startTime + shift }),
						},
			);
		},
	});

	const video =
		replacement.type === "video"
			? [{ ...replacement, isSourceAudioEnabled: !separated }]
			: [];
	const audio =
		replacement.type === "audio"
			? [replacement]
			: separatedTrack && chosen.item.hasAudio !== false
				? [
						{
							...buildSeparatedAudioClip({ sourceClip: replacement }),
							id: generateUUID(),
						},
					]
				: [];
	return {
		tracks: insertTakeClips({
			tracks: shifted,
			video,
			audio,
			videoTrackId: trackId,
			audioTrackId: separatedTrack?.id ?? trackId,
		}),
		start,
		end,
		delta,
	};
}
