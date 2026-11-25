import { stableStringify } from "@/approval/compare";
import { getSourceTimeAtClipTime } from "@/retime";
import { hasMediaId, type TimelineClip, type TSequence } from "@/timeline";
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

function transition({
	left,
	right,
}: {
	left: TimelineClip | undefined;
	right: TimelineClip | undefined;
}) {
	const gapSeconds =
		left && right
			? Math.max(0, seconds(right.startTime - left.startTime - left.duration))
			: null;
	const jumpCut = !!(
		left &&
		right &&
		left !== right &&
		gapSeconds === 0 &&
		left.type === "video" &&
		right.type === "video" &&
		left.mediaId === right.mediaId &&
		roundMediaTime({
			time:
				left.trimStart +
				getSourceTimeAtClipTime({
					clipTime: left.duration,
					retime: left.retime,
				}),
		}) !== right.trimStart
	);
	return {
		left: summarizeClip(left),
		right: summarizeClip(right),
		gapSeconds,
		jumpCut,
	};
}

function boundary({ clips, at }: { clips: TimelineClip[]; at: number }) {
	const left = clips.findLast((clip) => clip.startTime < at);
	const right = clips.find((clip) => clip.startTime + clip.duration > at);
	return transition({ left, right });
}

function joins(clips: TimelineClip[]) {
	return clips.slice(1).flatMap((right, index) => {
		const left = clips[index];
		const result = transition({ left, right });
		return result.jumpCut || (result.gapSeconds ?? 0) > 0 ? [result] : [];
	});
}

function joinKey({
	left,
	right,
	gapSeconds,
	jumpCut,
}: ReturnType<typeof transition>) {
	return JSON.stringify([left?.clipId, right?.clipId, gapSeconds, jumpCut]);
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
	const oldPicture = before.tracks.main.clips.toSorted(
		(a, b) => a.startTime - b.startTime,
	);
	const picture = after.tracks.main.clips.toSorted(
		(a, b) => a.startTime - b.startTime,
	);
	const oldJoins = new Set(joins(oldPicture).map(joinKey));
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
		newGapsAndJumpCuts: joins(picture).filter(
			(join) => !oldJoins.has(joinKey(join)),
		),
	};
}
