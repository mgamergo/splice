import type { RoughCutPlan, ItemRange } from "@splice/bridge/ops";
import { audibleClips } from "@/agent/loudness";
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
 * so a part only holds for its own clip.
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
	const placed = audibleClips({ tracks, projectItems }).map(({ clip }) => {
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
	const holes = unionSpans(placed.flatMap(({ sounding }) => sounding));
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
 * Each pause's silent parts in source seconds, joined across placements, so
 * tightening plans one cut for a pause split across a razor.
 */
function pausesInSource({
	parts,
	pauses,
}: {
	parts: SilentPart[];
	pauses: ItemRange[];
}): ItemRange[] {
	const spans: Array<Array<{ start: number; end: number }>> = pauses.map(
		() => [],
	);
	for (const { pauseIndex, sourceIn, sourceOut } of parts)
		spans[pauseIndex].push({ start: sourceIn, end: sourceOut });
	return spans.flatMap((found, index) =>
		unionSpans(found).map(({ start, end }) => ({
			projectItemId: pauses[index].projectItemId,
			sourceIn: start,
			sourceOut: end,
		})),
	);
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
}): Window[][] {
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
	const pauses: Window[][] = clamped.pauses.map(() => []);
	const partsByClip = Map.groupBy(silentParts, ({ clipId }) => clipId);
	for (const [clipId, parts] of partsByClip)
		map({
			ranges: parts,
			context: "Pause",
			tracks: keepClips({ tracks: heard, keep: ({ id }) => id === clipId }),
		}).forEach((found, index) =>
			pauses[parts[index].pauseIndex].push(...found),
		);
	// Planned in source seconds, so padding and filler edges follow the audio,
	// then kept only where a pause is silent at that placement or where a false
	// start or filler is.
	const tightening = intersectSpans({
		spans: map({
			ranges: planTightenCuts({
				...clamped,
				pauses: pausesInSource({ parts: silentParts, pauses: clamped.pauses }),
				paddingSeconds: plan.pausePaddingSeconds,
			}),
			context: "Cut",
		}).flat(),
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
	const cuts = closeSlivers({
		cuts: [...takeCuts, ...tightening],
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

	let tracks = source.tracks;
	const markers = [...source.markers];
	const sectionsRemoved = mapped.map(
		({ sectionName, bestTake, bestWindow, cuts: sectionCuts }) => {
			const marker: RemovalMarker = {
				id: generateUUID(),
				time: sectionCuts[0].start,
				data: {
					kind: "removal",
					sectionName,
					bestTake,
					badTakes: sectionCuts.map(({ take }) => take),
				},
			};
			markers.push(marker);
			tracks = tagBestTake({
				tracks,
				markerId: marker.id,
				clipIds: bestWindow.clipIds,
			});
			const removed = sectionCuts.reduce(
				(sum, { start, end }) => sum + end - start,
				0,
			);
			return { sectionName, removedSeconds: seconds(removed) };
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
	const spoken = [...takeCuts, ...falseStarts.flat(), ...fillerWords.flat()];
	const removedPauses = {
		...summarize({ found: pauses, without: spoken, within: cuts }),
		removedSeconds: seconds(
			measureSpans({ spans: tightening, within: cuts, without: spoken }),
		),
	};
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
	});
	const sequence: TSequence = {
		...source,
		id: generateUUID(),
		name,
		isMain: false,
		tracks: cut.tracks,
		markers: cut.markers.sort((a, b) => a.time - b.time),
		createdAt: new Date(),
		updatedAt: new Date(),
	};
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
