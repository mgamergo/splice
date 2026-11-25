import { resolveOpacityAtTime } from "@/animation/values";
import { readBlendModeFromParams, readOpacityFromParams } from "@/rendering";
import { stableStringify } from "@/approval/compare";
import { getSourceTimeAtClipTime } from "@/retime";
import {
	hasMediaId,
	type TimelineClip,
	type TSequence,
	type VideoTrack,
} from "@/timeline";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
} from "@/wasm";
import type { TimeRange } from "@/timeline/ripple-delete";

const seconds = (time: number) =>
	mediaTimeToSeconds({ time: roundMediaTime({ time }) });

const clipRange = (clip: TimelineClip): TimeRange => ({
	start: clip.startTime,
	end: roundMediaTime({ time: clip.startTime + clip.duration }),
});

function changedValues<T>({
	before,
	after,
	key,
	content = (value) => value,
}: {
	before: T[];
	after: T[];
	key: (value: T) => string;
	content?: (value: T) => unknown;
}): T[] {
	const old = Map.groupBy(before, key);
	const changed: T[] = [];
	for (const value of after) {
		const previous = old.get(key(value))?.pop();
		if (previous === undefined) {
			changed.push(value);
		} else {
			const a = content(previous);
			const b = content(value);
			if (a !== b && stableStringify(a) !== stableStringify(b))
				changed.push(previous, value);
		}
	}
	return [...changed, ...[...old.values()].flat()];
}

const tracksOf = ({ tracks }: TSequence) => [
	tracks.main,
	...tracks.overlay,
	...tracks.audio,
];

function sequenceChanges({
	before,
	after,
}: {
	before: TSequence;
	after: TSequence;
}) {
	const clipEntries = (sequence: TSequence) =>
		tracksOf(sequence).flatMap(({ id: trackId, clips }) =>
			clips.map((clip) => ({ trackId, clip })),
		);
	const clips = changedValues({
		before: clipEntries(before),
		after: clipEntries(after),
		key: ({ trackId, clip }) => JSON.stringify([trackId, clip.id]),
		content: ({ clip }) => clip,
	});
	const markers = changedValues({
		before: before.markers,
		after: after.markers,
		key: (marker) => marker.id ?? stableStringify(marker),
	});
	const ranges = [
		...clips.map(({ clip }) => clipRange(clip)),
		...markers.map(({ time, duration }) => ({
			start: time,
			end: roundMediaTime({ time: time + (duration ?? 0) }),
		})),
	];
	// Also check saved graphics, including hidden or off-sequence graphics.
	const graphics = changedValues({
		before: before.graphics?.records ?? [],
		after: after.graphics?.records ?? [],
		key: ({ id }) => id,
	});
	const sequenceWideChanges: string[] = [];
	for (const graphic of graphics) {
		const at = graphic.placed?.anchor ?? graphic.reviewTime;
		if (at === undefined) {
			sequenceWideChanges.push("off-sequence graphic");
		} else {
			// Graphic positions are already in sequence seconds.
			const anchor = mediaTimeFromSeconds({ seconds: at });
			ranges.push({ start: anchor, end: anchor });
		}
	}
	const afterTrackIds = new Set(tracksOf(after).map(({ id }) => id));
	const shared = new Set(
		tracksOf(before)
			.map(({ id }) => id)
			.filter((id) => afterTrackIds.has(id)),
	);
	const trackSettings = (sequence: TSequence) =>
		tracksOf(sequence)
			.filter(({ id }) => shared.has(id))
			.map(({ clips: _clips, ...track }) => track);
	if (
		stableStringify(trackSettings(before)) !==
		stableStringify(trackSettings(after))
	)
		sequenceWideChanges.push("track settings or order");
	if (stableStringify(before.captions) !== stableStringify(after.captions))
		sequenceWideChanges.push("saved Short captions");
	if (stableStringify(before.mix) !== stableStringify(after.mix))
		sequenceWideChanges.push("final mix");
	return { ranges, sequenceWideChanges };
}

function summarizeClip(clip: TimelineClip | undefined) {
	return clip
		? {
				clipId: clip.id,
				name: clip.name,
				start: seconds(clip.startTime),
				end: seconds(clip.startTime + clip.duration),
				...(hasMediaId(clip) && { projectItemId: clip.mediaId }),
			}
		: null;
}

type PictureClip = VideoTrack["clips"][number];
type PictureEdge = { clip: PictureClip; at: number };

const clipEnd = (clip: PictureClip) => clip.startTime + clip.duration;

function sourceAt({ clip, at }: PictureEdge) {
	return roundMediaTime({
		time:
			clip.trimStart +
			getSourceTimeAtClipTime({
				clipTime: at - clip.startTime,
				retime: clip.type === "video" ? clip.retime : undefined,
			}),
	});
}

function transition({
	left,
	right,
}: {
	left?: PictureEdge;
	right?: PictureEdge;
}) {
	const gapSeconds =
		left && right ? Math.max(0, seconds(right.at - left.at)) : null;
	const jumpCut = !!(
		left &&
		right &&
		left.clip !== right.clip &&
		gapSeconds === 0 &&
		left.clip.type === "video" &&
		right.clip.type === "video" &&
		left.clip.mediaId === right.clip.mediaId &&
		sourceAt(left) !== sourceAt(right)
	);
	return {
		left: summarizeClip(left?.clip),
		right: summarizeClip(right?.clip),
		gapSeconds,
		jumpCut,
	};
}

function pictureClips({ tracks }: TSequence): PictureClip[] {
	// Match the renderer's layer order and its overlap order within each track.
	return [...tracks.overlay, tracks.main].flatMap((track) =>
		track.type === "video" && !track.hidden
			? track.clips
					.filter((clip) => !clip.hidden)
					.toSorted(
						(a, b) => b.startTime - a.startTime || b.id.localeCompare(a.id),
					)
			: [],
	);
}

function isOpaque({ clip, at }: PictureEdge) {
	return (
		!clip.masks?.length &&
		readBlendModeFromParams({ params: clip.params }) === "normal" &&
		resolveOpacityAtTime({
			baseOpacity: readOpacityFromParams({ params: clip.params }),
			animations: clip.animations,
			localTime: at - clip.startTime,
		}) >= 1
	);
}

function boundary({ clips, at }: { clips: PictureClip[]; at: number }) {
	const visibleAt = ({
		point,
		side,
	}: {
		point: number;
		side: "left" | "right";
	}) => {
		const clip = clips.find(
			(clip) =>
				(side === "left"
					? clip.startTime < point && clipEnd(clip) >= point
					: clip.startTime <= point && clipEnd(clip) > point) &&
				isOpaque({ clip, at: point }),
		);
		return clip && { clip, at: point };
	};
	const adjacent = (side: "left" | "right") => {
		const visible = visibleAt({ point: at, side });
		if (visible) return visible;
		// When the edge is inside a gap, show the nearest picture on that side.
		const candidates =
			side === "left"
				? clips
						.map(clipEnd)
						.filter((end) => end < at)
						.sort((a, b) => b - a)
				: clips
						.map((clip) => clip.startTime)
						.filter((start) => start > at)
						.sort((a, b) => a - b);
		for (const point of candidates) {
			const edge = visibleAt({ point, side });
			if (edge) return edge;
		}
	};
	return transition({ left: adjacent("left"), right: adjacent("right") });
}

function joins({ tracks }: TSequence) {
	const clips = tracks.main.clips.toSorted((a, b) => a.startTime - b.startTime);
	return clips.slice(1).flatMap((clip, index) => {
		const left = { clip: clips[index], at: clipEnd(clips[index]) };
		const right = { clip, at: clip.startTime };
		const result = transition({ left, right });
		if (!result.jumpCut && (result.gapSeconds ?? 0) === 0) return [];
		// A split changes the clip ID but preserves the source at the join.
		const sourceKey = (edge: PictureEdge) => [
			edge.clip.mediaId,
			sourceAt(edge),
		];
		return [
			{
				key: JSON.stringify([
					sourceKey(left),
					sourceKey(right),
					result.gapSeconds,
					result.jumpCut,
				]),
				result,
			},
		];
	});
}

/** Compare the complete batch, including derived graphics and all tracks. */
export function sequenceEditImpact({
	before,
	after,
	scope,
}: {
	before: TSequence;
	after: TSequence;
	scope?: TimeRange;
}) {
	const { ranges, sequenceWideChanges } = sequenceChanges({ before, after });
	const affectedRange = ranges.length
		? ranges.reduce((a, b) => ({
				start: a.start < b.start ? a.start : b.start,
				end: a.end > b.end ? a.end : b.end,
			}))
		: undefined;
	const edges = scope ?? affectedRange;
	const oldPicture = pictureClips(before);
	const picture = pictureClips(after);
	const oldJoins = Map.groupBy(joins(before), ({ key }) => key);
	return {
		affectedRange: affectedRange
			? {
					start: seconds(affectedRange.start),
					end: seconds(affectedRange.end),
				}
			: null,
		sequenceWideChanges,
		...(scope && {
			scope: { start: seconds(scope.start), end: seconds(scope.end) },
			outsideScopeUntouched:
				sequenceWideChanges.length === 0 &&
				ranges.every(
					({ start, end }) => start >= scope.start && end <= scope.end,
				),
		}),
		adjacentTransitions: edges
			? {
					start: {
						before: boundary({ clips: oldPicture, at: edges.start }),
						after: boundary({ clips: picture, at: edges.start }),
					},
					end: {
						before: boundary({ clips: oldPicture, at: edges.end }),
						after: boundary({ clips: picture, at: edges.end }),
					},
				}
			: null,
		newGapsAndJumpCuts: joins(after).flatMap(({ key, result }) =>
			oldJoins.get(key)?.pop() ? [] : [result],
		),
	};
}
