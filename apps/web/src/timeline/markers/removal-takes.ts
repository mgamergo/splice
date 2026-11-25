import type {
	ItemRange,
	Take,
	TakeAudioSegment,
	TakePlacement,
	TakeSourceRange,
} from "@splice/bridge/ops";
import { isDiskMedia } from "@/media/media-data";
import type { ProjectItem } from "@/media/types";
import { getClipTimeAtSourceTime, getSourceSpanAtClipTime } from "@/retime";
import {
	buildSeparatedAudioClip,
	doesClipHaveEnabledAudio,
} from "@/timeline/audio-separation";
import {
	getClipVolume,
	hasAnimatedVolume,
	isClipMuted,
	isNoiseReduced,
} from "@/timeline/audio-state";
import {
	buildClipFromMedia,
	canClipHaveAudio,
	hasMediaId,
} from "@/timeline/clip-utils";
import { razorClip } from "@/timeline/razor";
import { canTrackHaveAudio } from "@/timeline/track-capabilities";
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
	mediaTimeToSeconds,
	roundMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export class RemovalTakeError extends Error {}

function resolveSourceRange({
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
	return {
		item,
		sourceIn,
		sourceOut,
		/** The take's in point as stored, which saved audio offsets start from. */
		sourceInSeconds: take.sourceIn,
	};
}

export function takeRanges(take: Take): TakeSourceRange[] {
	return "ranges" in take ? take.ranges : [take];
}

export function resolveTake({
	take,
	projectItems,
}: {
	take: Take;
	projectItems: ProjectItem[];
}) {
	return takeRanges(take).map((range) =>
		resolveSourceRange({ take: range, projectItems }),
	);
}

type ResolvedRange = ReturnType<typeof resolveSourceRange>;
type ResolvedTake = ResolvedRange[];

interface TakeAudio {
	/** Absent when the recording's clips all have keyframed volume. */
	volume?: number;
	noiseReduction: boolean;
}

type TrackClip = { clip: TimelineClip; trackId: string };

function mostCommon<T>(values: T[]): T | undefined {
	const counts = new Map<T, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	let most: T | undefined;
	let mostCount = 0;
	for (const [value, count] of counts)
		if (count > mostCount) {
			most = value;
			mostCount = count;
		}
	return most;
}

/**
 * The noise reduction and clip volume each project item's audible clips mostly
 * play with, so restored and swapped takes keep a recording's gain, such as the
 * one loudness normalization set, and its noise reduction, instead of jumping
 * back to the source audio. The volume is the one its clips with that noise
 * reduction play at; keyframed volume has no single value, so it only counts
 * towards noise reduction.
 */
function itemAudio({
	clips,
	items,
}: {
	clips: TimelineClip[];
	items: Map<string, ProjectItem>;
}): Map<string, TakeAudio> {
	const heard = new Map<
		string,
		Array<{ volume: number | undefined; noiseReduction: boolean }>
	>();
	for (const clip of clips) {
		if (!canClipHaveAudio(clip) || !hasMediaId(clip)) continue;
		const item = items.get(clip.mediaId);
		if (!item || !doesClipHaveEnabledAudio({ clip, projectItem: item }))
			continue;
		const list = heard.get(item.id) ?? [];
		list.push({
			volume: hasAnimatedVolume({ clip }) ? undefined : getClipVolume({ clip }),
			noiseReduction: isNoiseReduced({ clip }),
		});
		heard.set(item.id, list);
	}
	return new Map(
		Array.from(heard, ([id, list]) => {
			const noiseReduction =
				mostCommon(list.map((audio) => audio.noiseReduction)) === true;
			const volume = mostCommon(
				list.flatMap((audio) =>
					audio.noiseReduction === noiseReduction &&
					audio.volume !== undefined
						? [audio.volume]
						: [],
				),
			);
			return [id, { noiseReduction, ...(volume !== undefined && { volume }) }];
		}),
	);
}

const trackClips = (tracks: SequenceTracks) =>
	[tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
		track.clips.map((clip): TrackClip => ({ clip, trackId: track.id })),
	);

/** How each take's recording is heard: muted clips and tracks don't count. */
function takesAudio({
	tracks,
	takes,
}: {
	tracks: SequenceTracks;
	takes: ResolvedRange[];
}): Map<string, TakeAudio> {
	return itemAudio({
		clips: [tracks.main, ...tracks.overlay, ...tracks.audio]
			.filter((track) => !(canTrackHaveAudio(track) && track.muted))
			.flatMap((track): TimelineClip[] => track.clips)
			.filter((clip) => !(canClipHaveAudio(clip) && isClipMuted({ clip }))),
		items: new Map(takes.map(({ item }) => [item.id, item])),
	});
}

/**
 * A take's audio: how it played when it was swapped out, else how its
 * recording plays elsewhere in the sequence. A saved gain stays paired with
 * its saved noise reduction; without one (keyframed volume), the recording's
 * gain is used only when its clips share that noise reduction.
 */
function takeAudio({
	take,
	audioByItem,
	saved,
}: {
	take: ResolvedRange;
	audioByItem: Map<string, TakeAudio>;
	saved?: Pick<TakePlacement, "volume" | "noiseReduction">;
}): TakeAudio {
	const audio = audioByItem.get(take.item.id);
	if (saved?.noiseReduction === undefined && saved?.volume === undefined)
		return audio ?? { noiseReduction: false };
	const noiseReduction = saved.noiseReduction === true;
	const volume =
		saved.volume ??
		(audio?.noiseReduction === noiseReduction ? audio.volume : undefined);
	return { noiseReduction, ...(volume !== undefined && { volume }) };
}

type TakeStretch = {
	range: ResolvedRange;
	audio: TakeAudio;
	/** The track a video take's audio was extracted to, when it was. */
	audioTrackId?: string;
};

/**
 * The take's range split where its saved audio changes, each stretch with its
 * own audio and audio track. Placements saved before per-stretch audio play as
 * one stretch.
 */
function takeStretches({
	take,
	audioByItem,
	placement,
}: {
	take: ResolvedRange;
	audioByItem: Map<string, TakeAudio>;
	placement?: TakePlacement;
}): TakeStretch[] {
	const segments = placement?.audioSegments;
	if (!segments)
		return [
			{
				range: take,
				audio: takeAudio({ take, audioByItem, saved: placement }),
				audioTrackId: placement?.audioTrackId,
			},
		];
	const starts = segments.map(({ from }, index) => {
		const start = mediaTimeFromSeconds({ seconds: from });
		return index === 0 || start < take.sourceIn ? take.sourceIn : start;
	});
	return segments.flatMap((segment, index) => {
		const sourceIn = starts[index];
		const next = starts[index + 1];
		const sourceOut =
			next === undefined || next > take.sourceOut ? take.sourceOut : next;
		return sourceOut > sourceIn
			? [
					{
						range: { ...take, sourceIn, sourceOut },
						audio: takeAudio({ take, audioByItem, saved: segment }),
						audioTrackId: segment.audioTrackId,
					},
				]
			: [];
	});
}

/**
 * Where the take's audio changes partway, as when it was split into a
 * denoised clip and a plain one, or into a clip playing its own audio and one
 * with extracted audio: each setting in source order. Undefined when the whole
 * take plays one way.
 */
function audioSegments({
	clips,
	range,
}: {
	clips: TrackClip[];
	range: ResolvedRange;
}): TakeAudioSegment[] | undefined {
	const heard = clips
		.flatMap(({ clip, trackId }) =>
			canClipHaveAudio(clip) &&
			hasMediaId(clip) &&
			clip.mediaId === range.item.id &&
			doesClipHaveEnabledAudio({ clip, projectItem: range.item })
				? [
						{
							sourceIn: clip.trimStart,
							volume: hasAnimatedVolume({ clip })
								? undefined
								: getClipVolume({ clip }),
							noiseReduction: isNoiseReduced({ clip }),
							// A video take's audio clips are its extracted audio.
							audioTrackId:
								clip.type === "audio" && range.item.type === "video"
									? trackId
									: undefined,
						},
					]
				: [],
		)
		.sort((a, b) => a.sourceIn - b.sourceIn);
	const segments: TakeAudioSegment[] = [];
	for (const { sourceIn, volume, noiseReduction, audioTrackId } of heard) {
		const last = segments.at(-1);
		if (
			last &&
			last.volume === volume &&
			last.noiseReduction === noiseReduction &&
			last.audioTrackId === audioTrackId
		)
			continue;
		// The first stretch starts at the take's in point as stored, so the
		// offsets validate against it; later ones start inside the take.
		const from = last
			? mediaTimeToSeconds({ time: sourceIn })
			: range.sourceInSeconds;
		if (last && from <= last.from) continue;
		segments.push({
			from,
			...(volume !== undefined && { volume }),
			noiseReduction,
			...(audioTrackId && { audioTrackId }),
		});
	}
	return segments.length > 1 ? segments : undefined;
}

function createTakeClip({
	take,
	at,
	audio,
}: {
	take: ResolvedRange;
	at: MediaTime;
	audio: TakeAudio;
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
		params: {
			...clip.params,
			...(audio.volume !== undefined && { volume: audio.volume }),
			// Only Footage has a noise-reduced render, as set_noise_reduction checks.
			...(audio.noiseReduction &&
				isDiskMedia(take.item.file) && { noiseReduction: true }),
		},
		id: generateUUID(),
		duration: roundMediaTime({ time: take.sourceOut - take.sourceIn }),
		trimStart: take.sourceIn,
		trimEnd: roundMediaTime({ time: sourceDuration - take.sourceOut }),
	};
}

type AudioSegment = {
	groupId: string | undefined;
	separated: boolean;
	start: MediaTime;
	end: MediaTime;
};

type SourceWindow = Pick<ResolvedRange, "sourceIn" | "sourceOut"> & {
	item: { id: string };
};

type RangeWindow<Range = ResolvedRange> = {
	range: Range;
	start: MediaTime;
	end: MediaTime;
	sourceIn: number;
	sourceOut: number;
	trackId: string;
	clipIds: string[];
	audioSegments: AudioSegment[];
};

function findTakeWindows<Range extends SourceWindow>({
	track,
	take,
	markerId,
	audioGroupIds,
	complete,
}: {
	track: TimelineTrack;
	take: Range;
	markerId?: string;
	audioGroupIds?: Set<string>;
	complete: boolean;
}): RangeWindow<Range>[] {
	const windows: RangeWindow<Range>[] = [];
	for (const clip of [...track.clips].sort(
		(a, b) => a.startTime - b.startTime,
	)) {
		if (
			(clip.type !== "video" && clip.type !== "audio") ||
			!("mediaId" in clip) ||
			clip.mediaId !== take.item.id ||
			(markerId && !clip.bestTakeMarkerIds?.includes(markerId)) ||
			(audioGroupIds &&
				(!clip.sourceAudioGroupId ||
					!audioGroupIds.has(clip.sourceAudioGroupId)))
		)
			continue;

		const clipSourceOut =
			clip.trimStart +
			roundMediaTime({
				time: getSourceSpanAtClipTime({
					clipTime: clip.duration,
					retime: clip.retime,
				}),
			});
		const sourceIn = Math.max(clip.trimStart, take.sourceIn);
		const sourceOut = Math.min(clipSourceOut, take.sourceOut);
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
		const end =
			sourceOut === clipSourceOut
				? roundMediaTime({ time: clip.startTime + clip.duration })
				: toTimeline(sourceOut);
		if (end <= start) continue;

		const separated =
			clip.type === "video" && clip.isSourceAudioEnabled === false;
		const previous = windows.at(-1);
		if (
			previous &&
			previous.end === start &&
			(complete
				? previous.sourceOut === sourceIn
				: previous.sourceOut <= sourceIn)
		) {
			previous.end = end;
			previous.sourceOut = sourceOut;
			previous.clipIds.push(clip.id);
			const lastAudio = previous.audioSegments.at(-1);
			if (
				lastAudio &&
				lastAudio.groupId === clip.sourceAudioGroupId &&
				lastAudio.separated === separated
			) {
				lastAudio.end = end;
			} else {
				previous.audioSegments.push({
					groupId: clip.sourceAudioGroupId,
					separated,
					start,
					end,
				});
			}
		} else {
			windows.push({
				range: take,
				start,
				end,
				sourceIn,
				sourceOut,
				trackId: track.id,
				clipIds: [clip.id],
				audioSegments: [
					{ groupId: clip.sourceAudioGroupId, separated, start, end },
				],
			});
		}
	}
	return complete
		? windows.filter(
				(window) =>
					window.sourceIn === take.sourceIn &&
					window.sourceOut === take.sourceOut,
			)
		: windows;
}

type TakeWindow = {
	start: MediaTime;
	end: MediaTime;
	parts: RangeWindow[];
};

function takeWindows({
	tracks,
	take,
	markerId,
	complete = false,
}: {
	tracks: SequenceTracks;
	take: ResolvedTake;
	markerId?: string;
	complete?: boolean;
}): TakeWindow[] {
	const forRange = (range: ResolvedRange) => {
		const candidates =
			range.item.type === "video"
				? [
						tracks.main,
						...tracks.overlay.filter(({ type }) => type === "video"),
					]
				: tracks.audio;
		return candidates.flatMap((track) =>
			findTakeWindows({ track, take: range, markerId, complete }),
		);
	};
	// Count routes per candidate (capped at 2) instead of listing every path:
	// duplicated cuts on parallel tracks would otherwise grow 2^ranges paths.
	let nodes: PathNode[] | undefined;
	for (const range of take) {
		const parts = forRange(range);
		// A range that shows nowhere was cut whole, say as a false start by
		// Tighten. The surviving ranges still form the take.
		if (!complete && !parts.length) continue;
		const previous = nodes;
		nodes = parts.flatMap((part) => {
			if (!previous) return [{ part, routes: 1 }];
			const joins = previous.filter((node) => node.part.end === part.start);
			if (!joins.length) return [];
			const routes = Math.min(
				2,
				joins.reduce((sum, node) => sum + node.routes, 0),
			);
			return [{ part, routes, previous: joins[0] }];
		});
	}
	return (nodes ?? []).flatMap((node) => {
		const parts: RangeWindow[] = [];
		for (let step: PathNode | undefined = node; step; step = step.previous)
			parts.unshift(step.part);
		const window = { start: parts[0].start, end: node.part.end, parts };
		// Several routes to one end are ambiguous; listing it twice tells callers so.
		return node.routes > 1 ? [window, window] : [window];
	});
}

type PathNode = { part: RangeWindow; routes: number; previous?: PathNode };

/** Every contiguous run of the sequence, on any track, that shows part of `range`. */
export function mapSourceRangeToSequence({
	tracks,
	range,
	markerId,
}: {
	tracks: SequenceTracks;
	range: SourceWindow;
	markerId?: string;
}): Array<{ start: MediaTime; end: MediaTime; clipIds: string[] }> {
	return [tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
		findTakeWindows({ track, take: range, markerId, complete: false }).map(
			({ start, end, clipIds }) => ({ start, end, clipIds }),
		),
	);
}

/** Resolve a take only when its entire source maps to one contiguous window. */
export function mapTakeToSequence({
	tracks,
	take,
}: {
	tracks: SequenceTracks;
	take: ResolvedTake;
}) {
	const windows = takeWindows({ tracks, take, complete: true });
	if (windows.length !== 1) {
		throw new RemovalTakeError(
			windows.length
				? "The source ranges match multiple places in the sequence. Use an unambiguous source sequence."
				: "The source ranges do not map to one contiguous run of clips. Check the source times and recording order.",
		);
	}
	const { start, end, parts } = windows[0];
	linkedAudioWindows({ tracks, parts });
	return { start, end, clipIds: parts.flatMap((part) => part.clipIds) };
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

export function clearBestTake({
	tracks,
	markerId,
}: {
	tracks: SequenceTracks;
	markerId: string;
}): SequenceTracks {
	return mapTracks({
		tracks,
		map: (clips) =>
			clips.map((clip) => {
				if (!clip.bestTakeMarkerIds?.includes(markerId)) return clip;
				const remaining = clip.bestTakeMarkerIds.filter(
					(id) => id !== markerId,
				);
				return {
					...clip,
					bestTakeMarkerIds: remaining.length ? remaining : undefined,
				};
			}),
	});
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

type PlacedClip<Clip extends VideoClip | AudioClip> = {
	clip: Clip;
	trackId?: string;
};

function insertTakeClips({
	tracks,
	video,
	audio,
}: {
	tracks: SequenceTracks;
	video: PlacedClip<VideoClip>[];
	audio: PlacedClip<AudioClip>[];
}): SequenceTracks {
	const atTrack = <Clip extends VideoClip | AudioClip>({
		entries,
		trackId,
	}: {
		entries: PlacedClip<Clip>[];
		trackId?: string;
	}) =>
		entries
			.filter((entry) => entry.trackId === trackId)
			.map(({ clip }) => clip);
	const put = <Track extends { clips: TimelineClip[] }>({
		track,
		clips,
	}: {
		track: Track;
		clips: Track["clips"];
	}): Track =>
		clips.length
			? {
					...track,
					clips: [...track.clips, ...clips].sort(
						(a, b) => a.startTime - b.startTime,
					),
				}
			: track;
	const newVideo = atTrack({ entries: video });
	const newAudio = atTrack({ entries: audio });
	return {
		main: put({
			track: tracks.main,
			clips: atTrack({ entries: video, trackId: tracks.main.id }),
		}),
		overlay: [
			...(newVideo.length
				? [
						{
							...buildEmptyTrack({ id: generateUUID(), type: "video" }),
							clips: newVideo,
						},
					]
				: []),
			...tracks.overlay.map((track) =>
				track.type === "video"
					? put({
							track,
							clips: atTrack({ entries: video, trackId: track.id }),
						})
					: track,
			),
		],
		audio: [
			...tracks.audio.map((track) =>
				put({ track, clips: atTrack({ entries: audio, trackId: track.id }) }),
			),
			...(newAudio.length
				? [
						{
							...buildEmptyTrack({ id: generateUUID(), type: "audio" }),
							clips: newAudio,
						},
					]
				: []),
		],
	};
}

export function restoreTakeClips({
	tracks,
	takes,
	at,
}: {
	tracks: SequenceTracks;
	/** Placements saved by a swap put each range back on its track and audio track. */
	takes: Array<{ take: ResolvedTake; placements?: TakePlacement[] | null }>;
	at: MediaTime;
}) {
	const video: PlacedClip<VideoClip>[] = [];
	const audio: PlacedClip<AudioClip>[] = [];
	const videoTrack = (id?: string) =>
		[tracks.main, ...tracks.overlay].find(
			(track) => track.id === id && track.type === "video",
		)?.id;
	const audioTrack = (id?: string) =>
		tracks.audio.find((track) => track.id === id)?.id;
	const audioByItem = takesAudio({
		tracks,
		takes: takes.flatMap(({ take }) => take),
	});
	let end = at;
	for (const { take, placements } of takes) {
		for (const [index, range] of take.entries()) {
			const placement = placements?.[index];
			for (const stretch of takeStretches({
				take: range,
				audioByItem,
				placement,
			})) {
				const clip = createTakeClip({
					take: stretch.range,
					at: end,
					audio: stretch.audio,
				});
				end = roundMediaTime({ time: end + clip.duration });
				if (clip.type === "audio") {
					audio.push({
						clip,
						trackId: audioTrack(placement?.trackId) ?? tracks.audio[0]?.id,
					});
					continue;
				}
				const trackId = videoTrack(placement?.trackId) ?? tracks.main.id;
				const audioTrackId = audioTrack(stretch.audioTrackId);
				if (!audioTrackId || range.item.hasAudio === false) {
					video.push({ clip, trackId });
					continue;
				}
				const paired = {
					...clip,
					isSourceAudioEnabled: false,
					sourceAudioGroupId: generateUUID(),
				};
				video.push({ clip: paired, trackId });
				audio.push({
					clip: {
						...buildSeparatedAudioClip({ sourceClip: paired }),
						id: generateUUID(),
					},
					trackId: audioTrackId,
				});
			}
		}
	}
	const delta = end - at;
	const shifted = mapTracks({
		tracks,
		map: (clips) => spliceClips({ clips, start: at, end: at, delta }),
	});
	return {
		tracks: insertTakeClips({ tracks: shifted, video, audio }),
		delta,
	};
}

function nearestBestWindow({
	tracks,
	marker,
	best,
	initialTolerance,
}: {
	tracks: SequenceTracks;
	marker: RemovalMarker;
	best: ResolvedTake;
	initialTolerance?: MediaTime;
}): TakeWindow | undefined {
	const distance = ({ start, end }: TakeWindow) =>
		Math.max(start - marker.time, marker.time - end, 0);
	const windows = takeWindows({
		tracks,
		take: best,
		markerId: initialTolerance === undefined ? marker.id : undefined,
	});
	if (initialTolerance !== undefined) {
		const nearby = windows.filter(
			(window) => distance(window) <= initialTolerance,
		);
		return nearby.length === 1 ? nearby[0] : undefined;
	}
	const [nearest, alternative] = windows.sort(
		(a, b) => distance(a) - distance(b),
	);
	return alternative && distance(nearest) === distance(alternative)
		? undefined
		: nearest;
}

function linkedAudioWindows({
	tracks,
	parts,
}: {
	tracks: SequenceTracks;
	parts: RangeWindow[];
}): RangeWindow[] {
	return parts.flatMap(({ range, audioSegments }) =>
		audioSegments
			.filter(({ separated }) => separated)
			.map(({ groupId, start, end }) => {
				const windows = groupId
					? tracks.audio
							.flatMap((track) =>
								findTakeWindows({
									track,
									take: range,
									audioGroupIds: new Set([groupId]),
									complete: false,
								}),
							)
							.filter(
								(candidate) =>
									candidate.start === start && candidate.end === end,
							)
					: [];
				if (windows.length !== 1)
					throw new RemovalTakeError(
						"Align the extracted audio with the take before editing.",
					);
				return windows[0];
			}),
	);
}

export function markBestTake({
	tracks,
	marker,
	best,
	initialTolerance,
}: {
	tracks: SequenceTracks;
	marker: RemovalMarker;
	best: ResolvedTake;
	initialTolerance: MediaTime;
}): SequenceTracks {
	const window = nearestBestWindow({ tracks, marker, best, initialTolerance });
	return window
		? tagBestTake({
				tracks,
				markerId: marker.id,
				clipIds: window.parts.flatMap((part) => part.clipIds),
			})
		: tracks;
}

export function tagBestTake({
	tracks,
	markerId,
	clipIds,
}: {
	tracks: SequenceTracks;
	markerId: string;
	clipIds: string[];
}): SequenceTracks {
	const ids = new Set(clipIds);
	return mapTracks({
		tracks,
		map: (clips) =>
			clips.map((clip) =>
				ids.has(clip.id)
					? {
							...clip,
							bestTakeMarkerIds: [...(clip.bestTakeMarkerIds ?? []), markerId],
						}
					: clip,
			),
	});
}

/**
 * Where a range that Tighten cut whole goes back: on the tracks of the
 * nearest surviving range, preferring one of the same kind, with its own
 * recording's gain and noise reduction.
 */
function neighborPlacement({
	take,
	index,
	placed,
}: {
	take: ResolvedTake;
	index: number;
	placed: Map<ResolvedRange, TakePlacement>;
}): TakePlacement {
	const kind = take[index].item.type;
	const rank = (at: number) =>
		Math.abs(at - index) + (take[at].item.type === kind ? 0 : take.length);
	const [nearest] = take
		.flatMap((range, at) => {
			const placement = placed.get(range);
			return placement ? [{ placement, at }] : [];
		})
		.sort((a, b) => rank(a.at) - rank(b.at));
	if (!nearest)
		throw new RemovalTakeError(
			"Could not identify the best take near this marker.",
		);
	const { trackId, audioTrackId } = nearest.placement;
	return { trackId, ...(audioTrackId ? { audioTrackId } : {}) };
}

export function swapTakeClips({
	tracks,
	marker,
	best,
	chosen,
	chosenPlacements,
}: {
	tracks: SequenceTracks;
	marker: RemovalMarker;
	best: ResolvedTake;
	chosen: ResolvedTake;
	chosenPlacements?: TakePlacement[];
}) {
	const bestWindow = nearestBestWindow({ tracks, marker, best });
	if (!bestWindow) {
		throw new RemovalTakeError(
			"Could not identify the best take near this marker.",
		);
	}

	const { start, end, parts } = bestWindow;
	const previousRanges = parts.flatMap((part): ItemRange[] => {
		const source = [tracks.main, ...tracks.overlay, ...tracks.audio].find(
			({ id }) => id === part.trackId,
		);
		return part.clipIds.flatMap((id) => {
			const clip = source?.clips.find((clip) => clip.id === id);
			if (!clip || (clip.type !== "video" && clip.type !== "audio")) return [];
			const sourceIn = Math.max(clip.trimStart, part.sourceIn);
			const sourceOut = Math.min(
				clip.trimStart +
					roundMediaTime({
						time: getSourceSpanAtClipTime({
							clipTime: clip.duration,
							retime: clip.retime,
						}),
					}),
				part.sourceOut,
			);
			return sourceOut > sourceIn
				? [
						{
							projectItemId: part.range.item.id,
							sourceIn: mediaTimeToSeconds({
								time: roundMediaTime({ time: sourceIn }),
							}),
							sourceOut: mediaTimeToSeconds({
								time: roundMediaTime({ time: sourceOut }),
							}),
						},
					]
				: [];
		});
	});
	const videoParts = parts.filter(({ range }) => range.item.type === "video");
	const audioParts = parts.filter(({ range }) => range.item.type === "audio");
	const audioForVideo = new Map(
		videoParts.map((part) => [
			part,
			linkedAudioWindows({ tracks, parts: [part] }),
		]),
	);
	const linkedAudio = [...audioForVideo.values()].flat();

	const windowsByTrack = new Map<string, RangeWindow[]>();
	for (const part of [...parts, ...linkedAudio]) {
		const windows = windowsByTrack.get(part.trackId) ?? [];
		windows.push(part);
		windowsByTrack.set(part.trackId, windows);
	}

	const video: PlacedClip<VideoClip>[] = [];
	const audio: PlacedClip<AudioClip>[] = [];
	const audioByItem = takesAudio({ tracks, takes: chosen });
	let replacementEnd = start;
	let videoIndex = 0;
	let audioIndex = 0;
	for (const [index, range] of chosen.entries()) {
		const placement = chosenPlacements?.[index];
		// Stretches of one range all go where the part they replace was.
		const isAudio = range.item.type === "audio";
		const audioPart = isAudio
			? audioParts.at(Math.min(audioIndex++, audioParts.length - 1))
			: undefined;
		const videoPart = isAudio
			? undefined
			: videoParts.at(Math.min(videoIndex++, videoParts.length - 1));
		for (const stretch of takeStretches({
			take: range,
			audioByItem,
			placement,
		})) {
			const clip = {
				...createTakeClip({
					take: stretch.range,
					at: replacementEnd,
					audio: stretch.audio,
				}),
				bestTakeMarkerIds: [marker.id],
			};
			replacementEnd = roundMediaTime({
				time: replacementEnd + clip.duration,
			});
			if (clip.type === "audio") {
				const trackId =
					tracks.audio.find(({ id }) => id === placement?.trackId)?.id ??
					audioPart?.trackId ??
					linkedAudio[0]?.trackId;
				audio.push({ clip, trackId });
				continue;
			}
			const trackId =
				[tracks.main, ...tracks.overlay].find(
					({ id, type }) => id === placement?.trackId && type === "video",
				)?.id ??
				videoPart?.trackId ??
				(tracks.main.clips.length === 0 ? tracks.main.id : undefined);
			const audioTrackId =
				placement && !stretch.audioTrackId
					? undefined
					: (tracks.audio.find(({ id }) => id === stretch.audioTrackId)?.id ??
						(videoPart && audioForVideo.get(videoPart)?.[0]?.trackId) ??
						linkedAudio[0]?.trackId);
			if (audioTrackId && range.item.hasAudio !== false) {
				const paired = {
					...clip,
					isSourceAudioEnabled: false,
					sourceAudioGroupId: generateUUID(),
				};
				video.push({ clip: paired, trackId });
				audio.push({
					clip: {
						...buildSeparatedAudioClip({ sourceClip: paired }),
						id: generateUUID(),
					},
					trackId: audioTrackId,
				});
			} else {
				video.push({ clip, trackId });
			}
		}
	}

	const delta = replacementEnd - end;
	const shifted = mapTracks({
		tracks,
		map: (clips, id) => {
			const windows = windowsByTrack.get(id) ?? [];
			const remaining = windows.reduce(
				(current, part) =>
					spliceClips({
						clips: current,
						start: part.start,
						end: part.end,
						delta: 0,
					}),
				clips,
			);
			const precedingEnd = remaining.reduce<number>(
				(latest, clip) =>
					clip.startTime < end
						? Math.max(latest, clip.startTime + clip.duration)
						: latest,
				ZERO_MEDIA_TIME,
			);
			const firstFollowing = remaining.reduce(
				(earliest, clip) =>
					clip.startTime >= end ? Math.min(earliest, clip.startTime) : earliest,
				Infinity,
			);
			const insertions = [...video, ...audio].filter(
				({ trackId }) => trackId === id,
			);
			const insertionOverlaps = insertions.some(({ clip: insert }) =>
				remaining.some(
					(clip) =>
						clip.startTime < end &&
						clip.startTime < insert.startTime + insert.duration &&
						insert.startTime < clip.startTime + clip.duration,
				),
			);
			if (insertionOverlaps || firstFollowing + delta < precedingEnd) {
				throw new RemovalTakeError(
					"Swapping would overlap clips on another track.",
				);
			}
			return remaining.map((clip) =>
				clip.startTime < end
					? clip
					: {
							...clip,
							startTime: roundMediaTime({ time: clip.startTime + delta }),
						},
			);
		},
	});

	const placed = new Map(
		parts.map((part): [ResolvedRange, TakePlacement] => {
			const linked = audioForVideo.get(part) ?? [];
			const audioTrackId = linked[0]?.trackId;
			const clipIds = new Set(
				[part, ...linked].flatMap(({ clipIds }) => clipIds),
			);
			const clips = trackClips(tracks).filter(({ clip }) =>
				clipIds.has(clip.id),
			);
			const audio = itemAudio({
				clips: clips.map(({ clip }) => clip),
				items: new Map([[part.range.item.id, part.range.item]]),
			}).get(part.range.item.id);
			const segments = audioSegments({ clips, range: part.range });
			return [
				part.range,
				{
					trackId: part.trackId,
					...(audioTrackId ? { audioTrackId } : {}),
					// Saved even at 0 dB and off, so swapping back restores them
					// rather than taking another clip's noise reduction and gain.
					...(audio && {
						...(audio.volume !== undefined && { volume: audio.volume }),
						noiseReduction: audio.noiseReduction,
					}),
					...(segments && { audioSegments: segments }),
				},
			];
		}),
	);
	// Saved even for one track, so swapping back can return to an overlay
	// that would otherwise be pruned once it's empty. Placements follow the
	// take's ranges, which is how restoring reads them.
	return {
		previousRanges,
		previousPlacements: best.map(
			(range, index): TakePlacement =>
				placed.get(range) ?? neighborPlacement({ take: best, index, placed }),
		),
		tracks: insertTakeClips({
			tracks: clearBestTake({ tracks: shifted, markerId: marker.id }),
			video,
			audio,
		}),
		start,
		end,
		delta,
	};
}
