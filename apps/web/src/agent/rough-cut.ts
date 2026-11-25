import { validateProtectedSections } from "@/agent/protected-sections";
import { tagTighteningEdges } from "@/agent/corrections";
import type { RoughCutPlan, ItemRange } from "@splice/bridge/ops";
import { audibleClips, heardClips } from "@/agent/loudness";
import {
	closeSlivers,
	countOverlapping,
	intersectSpans,
	measureSpans,
	outsideHoles,
	planTightenCuts,
	subtractSpans,
	unionSpans,
} from "@/agent/tighten";
import type { ProjectItem } from "@/media/types";
import {
	getClipTimeAtSourceTime,
	getSourceSpanAtClipTime,
	getSourceTimeAtClipTime,
} from "@/retime";
import {
	calculateTotalDuration,
	hasMediaId,
	type RemovalMarker,
	type SequenceTracks,
	type TimelineClip,
	type TSequence,
} from "@/timeline";
import { buildClipFromMedia } from "@/timeline/clip-utils";
import {
	mapSourceRangeToSequence,
	mapTakeToSequence,
	RemovalTakeError,
	resolveTake,
	tagBestTake,
} from "@/timeline/markers/removal-takes";
import { rippleDeleteRanges } from "@/timeline/ripple-delete";
import { buildEmptyTrack } from "@/timeline/placement";
import { buildDefaultSequence } from "@/timeline/sequences";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export const RAW_SEQUENCE_NAME = "Raw";

export function buildRawSequence({
	projectItemIds,
	projectItems,
}: {
	projectItemIds: string[];
	projectItems: ProjectItem[];
}): TSequence {
	const sequence = buildDefaultSequence({
		name: RAW_SEQUENCE_NAME,
		isMain: false,
	});
	const audio = buildEmptyTrack({ id: generateUUID(), type: "audio" });
	const seen = new Set<string>();
	let startTime = ZERO_MEDIA_TIME;
	for (const id of projectItemIds) {
		if (seen.has(id))
			throw new RemovalTakeError(
				`Project item ${id} is listed twice in recording order.`,
			);
		seen.add(id);
		const item = projectItems.find((candidate) => candidate.id === id);
		if (
			!item ||
			item.missing ||
			!item.duration ||
			!Number.isFinite(item.duration) ||
			item.duration <= 0 ||
			item.type === "image"
		) {
			throw new RemovalTakeError(
				`Project item ${id} must be an available video or audio recording with a duration.`,
			);
		}
		const duration = mediaTimeFromSeconds({ seconds: item.duration });
		if (duration <= 0)
			throw new RemovalTakeError(
				`Recording ${id} is too short to place on the sequence.`,
			);
		const clip = buildClipFromMedia({
			mediaId: item.id,
			mediaType: item.type,
			name: item.name,
			duration,
			startTime,
		});
		if (clip.type === "video")
			sequence.tracks.main.clips.push({ ...clip, id: generateUUID() });
		if (clip.type === "audio")
			audio.clips.push({ ...clip, id: generateUUID() });
		startTime = addMediaTime({ a: startTime, b: duration });
	}
	if (audio.clips.length) sequence.tracks.audio.push(audio);
	return sequence;
}

type Window = { start: MediaTime; end: MediaTime };

/** Detected silences can end a few milliseconds past the decoded duration. */
function clampToItems({
	ranges,
	projectItems,
}: {
	ranges: ItemRange[];
	projectItems: ProjectItem[];
}): ItemRange[] {
	return ranges.map((range) => {
		const duration = projectItems.find(
			({ id }) => id === range.projectItemId,
		)?.duration;
		return duration !== undefined && range.sourceOut > duration
			? { ...range, sourceOut: duration }
			: range;
	});
}

/** The sequence with only the clips `keep` accepts, on tracks that can be heard. */
function keepClips({
	tracks,
	keep,
}: {
	tracks: SequenceTracks;
	keep: (clip: TimelineClip) => boolean;
}): SequenceTracks {
	return {
		main: { ...tracks.main, clips: tracks.main.clips.filter(keep) },
		overlay: tracks.overlay.flatMap((track) =>
			track.type === "video"
				? [{ ...track, clips: track.clips.filter(keep) }]
				: [],
		),
		audio: tracks.audio.map((track) => ({
			...track,
			clips: track.clips.filter(keep),
		})),
	};
}

/**
 * The audible clips whose recording plays. A recording whose file left
 * Footage keeps its clips, but playback skips them, so they have no pauses to
 * find and sound over none.
 */
export function playedClips({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): ReturnType<typeof audibleClips> {
	const missing = new Set(
		projectItems.filter((item) => item.missing).map(({ id }) => id),
	);
	return audibleClips({ tracks, projectItems }).filter(
		({ clip }) => !missing.has(clip.mediaId),
	);
}

/** A part of a pause that is silent at one placement of its recording. */
export type SilentPart = ItemRange & {
	/** Index of the pause in the list given to `audiblePauses`. */
	pauseIndex: number;
	/** The clip whose placement was checked. */
	clipId: string;
};

/**
 * The parts of each pause where every recording heard on the sequence is
 * silent, in source seconds, each with the clip it is silent in. A ripple
 * delete cuts every track, so a pause in a muted clip, or under another
 * recording's sound, isn't cut. The same source time can be silent at one
 * placement of a recording and under another recording's sound at the next,
 * so a part only holds for its own clip. Audio that wasn't scanned, such as
 * library music, which has no project item, sounds throughout; a missing
 * recording's clips are silent.
 */
export function audiblePauses({
	tracks,
	pauses,
	projectItems,
}: {
	tracks: SequenceTracks;
	pauses: ItemRange[];
	projectItems: ProjectItem[];
}): SilentPart[] {
	const placed = playedClips({ tracks, projectItems }).map(({ clip }) => {
		const { startTime, trimStart, retime } = clip;
		const toSequence = (source: number) =>
			startTime +
			getClipTimeAtSourceTime({ sourceTime: source - trimStart, retime });
		const toSource = (time: number) =>
			mediaTimeToSeconds({
				time: roundMediaTime({
					time:
						trimStart +
						getSourceTimeAtClipTime({ clipTime: time - startTime, retime }),
				}),
			});
		const sourceIn = mediaTimeToSeconds({ time: trimStart });
		const sourceOut = mediaTimeToSeconds({
			time: addMediaTime({
				a: trimStart,
				b: roundMediaTime({
					time: getSourceSpanAtClipTime({ clipTime: clip.duration, retime }),
				}),
			}),
		});
		const silent = pauses.flatMap((pause, index) => {
			if (pause.projectItemId !== clip.mediaId) return [];
			const from = Math.max(pause.sourceIn, sourceIn);
			const to = Math.min(pause.sourceOut, sourceOut);
			if (to <= from) return [];
			return [
				{
					index,
					start: toSequence(mediaTimeFromSeconds({ seconds: from })),
					end: toSequence(mediaTimeFromSeconds({ seconds: to })),
					sourceIn: from,
					sourceOut: to,
				},
			];
		});
		const span = { start: startTime, end: startTime + clip.duration };
		return {
			clipId: clip.id,
			toSource,
			silent,
			sounding: subtractSpans({ within: [span], without: silent }),
		};
	});
	const scanned = new Set(projectItems.map(({ id }) => id));
	const unscanned = heardClips({ tracks, projectItems }).flatMap(({ clip }) =>
		hasMediaId(clip) && scanned.has(clip.mediaId)
			? []
			: [{ start: clip.startTime, end: clip.startTime + clip.duration }],
	);
	const holes = unionSpans([
		...placed.flatMap(({ sounding }) => sounding),
		...unscanned,
	]);
	return placed.flatMap(({ clipId, toSource, silent }) =>
		silent.flatMap((window) =>
			outsideHoles({ area: window, holes }).map(({ start, end }) => ({
				projectItemId: pauses[window.index].projectItemId,
				sourceIn: start === window.start ? window.sourceIn : toSource(start),
				sourceOut: end === window.end ? window.sourceOut : toSource(end),
				pauseIndex: window.index,
				clipId,
			})),
		),
	);
}

/**
 * Each pause's silent parts in source seconds, joined across the clips of one
 * placement, so tightening plans one cut for a pause split across a razor.
 */
function pausesInSource({
	parts,
	pauses,
}: {
	parts: SilentPart[];
	pauses: ItemRange[];
}): ItemRange[] {
	return [...Map.groupBy(parts, ({ pauseIndex }) => pauseIndex)].flatMap(
		([index, found]) =>
			unionSpans(
				found.map(({ sourceIn, sourceOut }) => ({
					start: sourceIn,
					end: sourceOut,
				})),
			).map(({ start, end }) => ({
				projectItemId: pauses[index].projectItemId,
				sourceIn: start,
				sourceOut: end,
			})),
	);
}

/** A run of heard clips that plays one recording without a jump. */
type Placement = Window & {
	projectItemId: string;
	clipIds: Set<string>;
	sourceAudioGroupIds: Set<string>;
	sourceIn: number;
	sourceOut: number;
};

/**
 * The heard clips grouped into placements: a clip that picks up where the one
 * before it on its track left off, in time and in source, continues it, as the
 * pieces of a razor do.
 */
function continuousPlacements({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): Placement[] {
	const placements: Placement[] = [];
	const byTrack = Map.groupBy(
		audibleClips({ tracks, projectItems }),
		({ trackId }) => trackId,
	);
	for (const clips of byTrack.values()) {
		let last:
			| {
					placement: Placement;
					sourceEnd: MediaTime;
					rate: number;
			  }
			| undefined;
		for (const { clip } of clips.sort(
			(a, b) => a.clip.startTime - b.clip.startTime,
		)) {
			const rate = clip.retime?.rate ?? 1;
			const sourceEnd = addMediaTime({
				a: clip.trimStart,
				b: roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: clip.duration,
						retime: clip.retime,
					}),
				}),
			});
			const continues =
				last &&
				last.placement.projectItemId === clip.mediaId &&
				last.placement.end === clip.startTime &&
				last.sourceEnd === clip.trimStart &&
				last.rate === rate;
			const placement: Placement =
				continues && last
					? last.placement
					: {
							projectItemId: clip.mediaId,
							clipIds: new Set(),
							sourceAudioGroupIds: new Set(),
							start: clip.startTime,
							end: clip.startTime,
							sourceIn: mediaTimeToSeconds({ time: clip.trimStart }),
							sourceOut: 0,
						};
			if (placement !== last?.placement) placements.push(placement);
			placement.clipIds.add(clip.id);
			if (clip.sourceAudioGroupId)
				placement.sourceAudioGroupIds.add(clip.sourceAudioGroupId);
			placement.end = addMediaTime({ a: clip.startTime, b: clip.duration });
			placement.sourceOut = mediaTimeToSeconds({ time: sourceEnd });
			last = {
				placement,
				sourceEnd,
				rate,
			};
		}
	}
	return placements;
}

/** Where each source range shows in the source sequence, on any track. */
function mapSourceRanges({
	tracks,
	ranges,
	projectItems,
	context,
}: {
	tracks: TSequence["tracks"];
	ranges: ItemRange[];
	projectItems: ProjectItem[];
	context: string;
}) {
	return ranges.map((range, index) => {
		if (range.sourceOut <= range.sourceIn) return [];
		try {
			const [resolved] = resolveTake({ take: range, projectItems });
			return mapSourceRangeToSequence({ tracks, range: resolved });
		} catch (error) {
			if (!(error instanceof RemovalTakeError)) throw error;
			throw new RemovalTakeError(`${context} ${index + 1}: ${error.message}`);
		}
	});
}

const byItem = ({ projectItemId }: ItemRange) => projectItemId;

const seconds = (time: number) =>
	mediaTimeToSeconds({ time: roundMediaTime({ time }) });

export function buildRoughCut({
	source,
	name,
	plan,
	projectItems,
	sliverDuration,
}: {
	source: TSequence;
	name: string;
	plan: RoughCutPlan;
	projectItems: ProjectItem[];
	/** Kept pieces shorter than this join the cut around them. */
	sliverDuration: MediaTime;
}) {
	const mapped = plan.sections.map(
		({ name: sectionName, takes, bestTakeIndex }, sectionIndex) => {
			const context = `Section ${sectionIndex + 1} (${sectionName})`;
			const bestTake = takes[bestTakeIndex];
			if (!bestTake)
				throw new RemovalTakeError(
					`${context}: bestTakeIndex ${bestTakeIndex} is outside the takes list.`,
				);
			const windows = takes.map((take, index) => {
				try {
					return {
						...mapTakeToSequence({
							tracks: source.tracks,
							take: resolveTake({ take, projectItems }),
						}),
						description: `${context}, take ${index + 1}`,
						take,
					};
				} catch (error) {
					if (!(error instanceof RemovalTakeError)) throw error;
					throw new RemovalTakeError(
						`${context}, take ${index + 1}: ${error.message}`,
					);
				}
			});
			return {
				sectionName,
				bestTake,
				bestWindow: windows[bestTakeIndex],
				cuts: windows
					.filter((_, index) => index !== bestTakeIndex)
					.sort((a, b) => a.start - b.start),
				windows,
			};
		},
	);

	const windows = mapped
		.flatMap((section) => section.windows)
		.sort((a, b) => a.start - b.start);
	for (let i = 1; i < windows.length; i++) {
		const previous = windows[i - 1];
		const current = windows[i];
		if (previous.end > current.start) {
			throw new RemovalTakeError(
				`${previous.description} overlaps ${current.description}. Give each take a distinct range.`,
			);
		}
	}

	if (!plan.restructure) {
		const inRecordingOrder = mapped
			.map((section) => ({
				...section,
				firstTakeAt: section.windows.reduce((first, { start }) => start < first ? start : first, section.bestWindow.start),
			}))
			.sort((a, b) => a.firstTakeAt - b.firstTakeAt);
		for (let i = 1; i < inRecordingOrder.length; i++) {
			const previous = inRecordingOrder[i - 1];
			const current = inRecordingOrder[i];
			if (current.bestWindow.start < previous.bestWindow.start)
				throw new RemovalTakeError(
					`The chosen takes put “${current.sectionName}” before “${previous.sectionName}”. Choose takes in teaching order, or pass restructure: true if the creator explicitly asked for that change.`,
				);
		}
	}

	const clamped = {
		pauses: clampToItems({ ranges: plan.pauses, projectItems }),
		falseStarts: clampToItems({ ranges: plan.falseStarts, projectItems }),
		fillerWords: clampToItems({ ranges: plan.fillerWords, projectItems }),
	};
	// Tightening cuts what plays, so a recording's muted copy elsewhere isn't cut.
	const heardIds = new Set(
		audibleClips({ tracks: source.tracks, projectItems }).map(
			({ clip }) => clip.id,
		),
	);
	const heard = keepClips({
		tracks: source.tracks,
		keep: ({ id }) => heardIds.has(id),
	});
	const map = ({
		ranges,
		context,
		tracks = heard,
	}: {
		ranges: ItemRange[];
		context: string;
		tracks?: SequenceTracks;
	}) => mapSourceRanges({ tracks, ranges, projectItems, context });
	const falseStarts = map({
		ranges: clamped.falseStarts,
		context: "False start",
	});
	falseStarts.forEach((found, index) => {
		if (!found.length)
			throw new RemovalTakeError(
				`False start ${index + 1} isn't heard on the source sequence. Check its project item and source times, and that its clip isn't muted.`,
			);
	});
	const fillerWords = map({
		ranges: clamped.fillerWords,
		context: "Filler word",
	});
	const silentParts = audiblePauses({
		tracks: source.tracks,
		pauses: clamped.pauses,
		projectItems,
	});
	// Each silent part maps only through the clip it was checked on, never to
	// another placement of the same source time. One group per pause, however
	// many silent parts it has.
	const pauses: ReturnType<typeof mapSourceRanges> = clamped.pauses.map(
		() => [],
	);
	const partsByClip = Map.groupBy(silentParts, ({ clipId }) => clipId);
	for (const [clipId, parts] of partsByClip)
		map({
			ranges: parts,
			context: "Pause",
			tracks: keepClips({ tracks: heard, keep: ({ id }) => id === clipId }),
		}).forEach((found, index) =>
			pauses[parts[index].pauseIndex].push(...found),
		);
	// Planned in source seconds for each placement, so padding and filler
	// edges follow the audio and a pause's padding comes from its own silence,
	// then kept only where a pause is silent at that placement or where a false
	// start or filler is.
	const placements = continuousPlacements({
		tracks: source.tracks,
		projectItems,
	});
	const placementOf = new Map(
		placements.flatMap((placement) =>
			[...placement.clipIds].map((clipId) => [clipId, placement] as const),
		),
	);
	const withPlacement = ({
		start,
		end,
		clipIds,
	}: (typeof pauses)[number][number]) => {
		return [...new Set(clipIds.map((id) => placementOf.get(id)))].flatMap(
			(placement) =>
				placement
					? [
							{
								start: start < placement.start ? placement.start : start,
								end: end > placement.end ? placement.end : end,
								placement,
							},
						]
					: [],
		);
	};
	const partsByPlacement = Map.groupBy(silentParts, ({ clipId }) =>
		placementOf.get(clipId),
	);
	const spokenByItem = {
		falseStarts: Map.groupBy(clamped.falseStarts, byItem),
		fillerWords: Map.groupBy(clamped.fillerWords, byItem),
	};
	const tightening = intersectSpans({
		spans: placements.flatMap((placement) => {
			const { projectItemId, clipIds, sourceIn, sourceOut } = placement;
			const here = (ranges: ItemRange[] = []) =>
				ranges.filter(
					(range) => range.sourceIn < sourceOut && range.sourceOut > sourceIn,
				);
			return map({
				ranges: planTightenCuts({
					pauses: pausesInSource({
						parts: partsByPlacement.get(placement) ?? [],
						pauses: clamped.pauses,
					}),
					falseStarts: here(spokenByItem.falseStarts.get(projectItemId)),
					fillerWords: here(spokenByItem.fillerWords.get(projectItemId)),
					paddingSeconds: plan.pausePaddingSeconds,
				}),
				context: "Cut",
				tracks: keepClips({ tracks: heard, keep: ({ id }) => clipIds.has(id) }),
			}).flat();
		}),
		within: [...pauses.flat(), ...falseStarts.flat(), ...fillerWords.flat()],
	});
	const takeCuts: Window[] = mapped.flatMap((section) => section.cuts);
	const clips = [
		source.tracks.main,
		...source.tracks.overlay,
		...source.tracks.audio,
	]
		.flatMap((track): TimelineClip[] => track.clips)
		.map((clip) => ({
			start: clip.startTime,
			end: roundMediaTime({ time: clip.startTime + clip.duration }),
		}));
	const closeAll = (removed: Window[]) =>
		closeSlivers({
			cuts: removed,
			// The whole timeline counts as a clip, so a cut never leaves a sliver of its start or end.
			clips: [
				...clips,
				{
					start: ZERO_MEDIA_TIME,
					end: calculateTotalDuration({ tracks: source.tracks }),
				},
			],
			minimum: sliverDuration,
		});
	const spoken = [...takeCuts, ...falseStarts.flat(), ...fillerWords.flat()];
	// A pause cut may only grow over silence found at its placement: a sliver
	// between two pauses can be a short word the detector kept.
	const cuts = intersectSpans({
		spans: closeAll([...takeCuts, ...tightening]),
		within: [...closeAll(spoken), ...pauses.flat()],
	});

	const deleted = unionSpans(cuts);
	const hasKeptMaterial = ({ spans, holes }: { spans: Window[]; holes: Window[] }) =>
		spans.some((area) => outsideHoles({ area, holes }).length > 0);

	let tracks = source.tracks;
	const markers = [...source.markers];
	const protectedSections = [...(source.protectedSections ?? [])];
	const sectionsRemoved = mapped.map(
		({ sectionName, bestTake, bestWindow, cuts: sectionCuts }) => {
			const removed = sectionCuts.reduce(
				(sum, { start, end }) => sum + end - start,
				0,
			);
			const report = { sectionName, removedSeconds: seconds(removed) };
			const sectionId = generateUUID();
			protectedSections.push({ id: sectionId, sectionName, bestTake });
			tracks = tagBestTake({
				tracks,
				markerId: sectionId,
				clipIds: bestWindow.clipIds,
			});
			if (
				sectionCuts.length &&
				hasKeptMaterial({ spans: [bestWindow], holes: deleted })
			) {
				const marker: RemovalMarker = {
					id: sectionId,
					time: sectionCuts[0].start,
					data: {
						kind: "removal",
						sectionName,
						bestTake,
						badTakes: sectionCuts.map(({ take }) => take),
					},
				};
				markers.push(marker);
			}
			return report;
		},
	);

	// Each removed moment counts once: bad takes, then false starts, filler words and pauses.
	const summarize = ({
		found,
		without,
		within = cuts,
	}: {
		found: Window[][];
		without: Window[];
		within?: Window[];
	}) => ({
		count: countOverlapping({ groups: found, within, without }),
		removedSeconds: seconds(
			measureSpans({ spans: found.flat(), within, without }),
		),
	});
	const removedFalseStarts = summarize({
		found: falseStarts,
		without: takeCuts,
	});
	const removedFillers = summarize({
		found: fillerWords,
		without: [...takeCuts, ...falseStarts.flat()],
	});
	// Pauses are credited only with the tightening they planned, so a pause
	// counts when some of it is credited; the time slivers add, even of a
	// pause, is reported as sliverSeconds.
	const removedPauses = summarize({
		found: pauses,
		without: spoken,
		within: intersectSpans({ spans: tightening, within: cuts }),
	});
	const total = measureSpans({ spans: cuts, within: cuts });
	const slivers =
		total - measureSpans({ spans: [...takeCuts, ...tightening], within: cuts });

	// Sorted while the cut points are distinct, so sections whose markers
	// collapse to one time keep their timeline order.
	markers.sort((a, b) => a.time - b.time);
	const cut = rippleDeleteRanges({
		tracks,
		markers,
		ranges: cuts,
		generateId: generateUUID,
		mapPiece: tagTighteningEdges({
			cuts,
			takeCuts,
			falseStarts: falseStarts.flat().flatMap(withPlacement),
			fillerWords: fillerWords.flat().flatMap(withPlacement),
			pauses: pauses.map((windows, index) => ({
				windows: windows.flatMap(withPlacement),
				pauseSeconds:
					clamped.pauses[index].sourceOut - clamped.pauses[index].sourceIn,
			})),
		}),
	});
	const sequence: TSequence = {
		...source,
		id: generateUUID(),
		name,
		isMain: false,
		tracks: cut.tracks,
		markers: cut.markers.sort((a, b) => a.time - b.time),
		protectedSections: protectedSections.length ? protectedSections : undefined,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	validateProtectedSections({
		before: { ...source, tracks, protectedSections },
		after: sequence,
		restructure: plan.restructure,
	});
	if (!plan.restructure) {
		const badTakes = unionSpans(takeCuts);
		const recordings = Map.groupBy(
			audibleClips({ tracks: source.tracks, projectItems }),
			({ clip }) => clip.mediaId,
		);
		for (const [itemId, recording] of recordings) {
			const spans = recording.map(({ clip }) => ({
				start: clip.startTime,
				end: addMediaTime({ a: clip.startTime, b: clip.duration }),
			}));
			// A recording can be entirely bad takes. Guard only the content left after take removal.
			if (
				hasKeptMaterial({ spans, holes: badTakes }) &&
				!hasKeptMaterial({ spans, holes: deleted })
			)
				throw new RemovalTakeError(
					`Tightening would remove all kept material from recording ${itemId}. Keep some of the recording, or pass restructure: true if the creator explicitly asked to remove it.`,
				);
		}
	}
	return {
		sequence,
		sections: sectionsRemoved,
		tightening: {
			pausePaddingSeconds: plan.pausePaddingSeconds,
			pauses: removedPauses,
			falseStarts: removedFalseStarts,
			fillerWords: removedFillers,
			sliverSeconds: seconds(slivers),
			removedSeconds: seconds(
				measureSpans({ spans: cuts, within: cuts, without: takeCuts }),
			),
		},
	};
}

export function sequenceDurationSeconds(sequence: TSequence): number {
	return mediaTimeToSeconds({
		time: calculateTotalDuration({ tracks: sequence.tracks }),
	});
}
