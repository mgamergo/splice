import type { RoughCutPlan, ItemRange } from "@splice/bridge/ops";
import {
	closeSlivers,
	countOverlapping,
	measureSpans,
	planTightenCuts,
} from "@/agent/tighten";
import type { ProjectItem } from "@/media/types";
import {
	calculateTotalDuration,
	type RemovalMarker,
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
	const map = ({
		ranges,
		context,
	}: {
		ranges: ItemRange[];
		context: string;
	}) =>
		mapSourceRanges({ tracks: source.tracks, ranges, projectItems, context });
	const falseStarts = map({
		ranges: clamped.falseStarts,
		context: "False start",
	});
	falseStarts.forEach((found, index) => {
		if (!found.length)
			throw new RemovalTakeError(
				`False start ${index + 1} isn't on the source sequence. Check its project item and source times.`,
			);
	});
	const fillerWords = map({
		ranges: clamped.fillerWords,
		context: "Filler word",
	});
	const pauses = map({ ranges: clamped.pauses, context: "Pause" });
	const tightening = map({
		ranges: planTightenCuts({
			...clamped,
			paddingSeconds: plan.pausePaddingSeconds,
		}),
		context: "Cut",
	}).flat();
	const takeCuts: Window[] = mapped.flatMap((section) => section.cuts);
	const cuts = closeSlivers({
		cuts: [...takeCuts, ...tightening],
		edges: [
			ZERO_MEDIA_TIME,
			...[source.tracks.main, ...source.tracks.overlay, ...source.tracks.audio]
				.flatMap((track): TimelineClip[] => track.clips)
				.flatMap((clip) => [
					clip.startTime,
					roundMediaTime({ time: clip.startTime + clip.duration }),
				]),
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
