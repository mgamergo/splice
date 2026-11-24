import { razorClip } from "@/timeline/razor";
import type { Marker, SequenceTracks, TimelineClip } from "@/timeline";
import {
	addMediaTime,
	type MediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export interface TimeRange {
	start: MediaTime;
	end: MediaTime;
}

/** Sorts ranges and merges any that overlap or touch. */
export function normalizeRanges({
	ranges,
}: {
	ranges: TimeRange[];
}): TimeRange[] {
	const sorted = ranges
		.filter((range) => range.end > range.start)
		.sort((a, b) => a.start - b.start);
	const merged: TimeRange[] = [];
	for (const range of sorted) {
		const last = merged.at(-1);
		if (last && range.start <= last.end) {
			if (range.end > last.end) last.end = range.end;
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

/** Number of the sorted, disjoint `ranges` that end at or before `time`. */
function countEndedBy({
	ranges,
	time,
}: {
	ranges: TimeRange[];
	time: MediaTime;
}): number {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (ranges[middle].end <= time) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * Removes every range from one track in a single pass. Each clip is cut by the
 * ranges it overlaps, last range first, then every piece moves left by the
 * length removed before it.
 */
function rippleDeleteClips<TClip extends TimelineClip>({
	clips,
	ranges,
	removedBefore,
	generateId,
}: {
	clips: TClip[];
	ranges: TimeRange[];
	removedBefore: (time: MediaTime) => MediaTime;
	generateId: () => string;
}): TClip[] {
	const place = (clip: TClip): TClip => {
		const removed = removedBefore(clip.startTime);
		return removed === 0
			? clip
			: { ...clip, startTime: subMediaTime({ a: clip.startTime, b: removed }) };
	};
	return clips.flatMap((clip): TClip[] => {
		const clipEnd = clip.startTime + clip.duration;
		const first = countEndedBy({ ranges, time: clip.startTime });
		let last = first;
		while (last < ranges.length && ranges[last].start < clipEnd) last++;
		if (last === first) return [place(clip)];

		// Pieces right of a range are final; only the part left of it is cut again.
		const pieces: TClip[] = [];
		let rest: TClip | undefined = clip;
		for (let index = last - 1; index >= first && rest; index--) {
			const range = ranges[index];
			const left: TClip | undefined =
				rest.startTime < range.start
					? razorClip({
							clip: rest,
							at: range.start,
							rightClipId: generateId(),
						})?.left
					: undefined;
			if (rest.startTime + rest.duration > range.end) {
				// When nothing of the clip survives before the range, the remaining
				// piece is still the same clip, so it keeps its id.
				const rightClipId = left ? generateId() : rest.id;
				const right = razorClip({
					clip: rest,
					at: range.end,
					rightClipId,
				})?.right;
				if (right) pieces.push(right);
			}
			rest = left;
		}
		if (rest) pieces.push(rest);
		return pieces.reverse().map(place);
	});
}

/**
 * Removes the given time ranges from every track and closes the gaps, the way
 * Premiere's ripple delete does. Removal markers in the cut move to its start
 * so their stored takes stay available. Later markers move with the clips.
 */
export function rippleDeleteRanges({
	tracks,
	markers,
	ranges,
	generateId,
}: {
	tracks: SequenceTracks;
	markers: Marker[];
	ranges: TimeRange[];
	generateId: () => string;
}): { tracks: SequenceTracks; markers: Marker[] } {
	const sorted = normalizeRanges({ ranges });
	// removed[i] is the total length of the first i ranges.
	const removed: MediaTime[] = [ZERO_MEDIA_TIME];
	for (const range of sorted)
		removed.push(
			addMediaTime({
				a: removed[removed.length - 1],
				b: subMediaTime({ a: range.end, b: range.start }),
			}),
		);
	const removedBefore = (time: MediaTime) =>
		removed[countEndedBy({ ranges: sorted, time })];
	const apply = <TTrack extends { clips: TimelineClip[] }>(
		track: TTrack,
	): TTrack => ({
		...track,
		clips: rippleDeleteClips({
			clips: track.clips,
			ranges: sorted,
			removedBefore,
			generateId,
		}),
	});
	return {
		tracks: {
			main: apply(tracks.main),
			overlay: tracks.overlay.map(apply),
			audio: tracks.audio.map(apply),
		},
		markers: markers.flatMap((marker): Marker[] => {
			const index = countEndedBy({ ranges: sorted, time: marker.time });
			const range = sorted[index];
			if (range && range.start <= marker.time) {
				return marker.data
					? [
							{
								...marker,
								time: subMediaTime({ a: range.start, b: removed[index] }),
							},
						]
					: [];
			}
			return removed[index] === 0
				? [marker]
				: [
						{
							...marker,
							time: subMediaTime({ a: marker.time, b: removed[index] }),
						},
					];
		}),
	};
}
