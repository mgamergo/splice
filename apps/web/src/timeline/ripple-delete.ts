import { razorClip } from "@/timeline/razor";
import type { Marker, SequenceTracks, TimelineClip } from "@/timeline";
import { type MediaTime, subMediaTime } from "@/wasm";

export interface TimeRange {
	start: MediaTime;
	end: MediaTime;
}

/** Sorts ranges and merges any that overlap or touch. */
export function normalizeRanges({ ranges }: { ranges: TimeRange[] }): TimeRange[] {
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

function rippleDeleteClips<TClip extends TimelineClip>({
	clips,
	range,
	generateId,
}: {
	clips: TClip[];
	range: TimeRange;
	generateId: () => string;
}): TClip[] {
	const length = subMediaTime({ a: range.end, b: range.start });
	return clips.flatMap((clip): TClip[] => {
		const clipEnd = clip.startTime + clip.duration;
		if (clipEnd <= range.start) return [clip];
		if (clip.startTime >= range.end) {
			return [{ ...clip, startTime: subMediaTime({ a: clip.startTime, b: length }) }];
		}

		const pieces: TClip[] = [];
		if (clip.startTime < range.start) {
			const cut = razorClip({ clip, at: range.start, rightClipId: generateId() });
			if (cut) pieces.push(cut.left);
		}
		if (clipEnd > range.end) {
			// When nothing of the clip survives before the range, the remaining
			// piece is still the same clip, so it keeps its id.
			const rightClipId = pieces.length === 0 ? clip.id : generateId();
			const cut = razorClip({ clip, at: range.end, rightClipId });
			if (cut) pieces.push({ ...cut.right, startTime: range.start });
		}
		return pieces;
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
	let nextTracks = tracks;
	let nextMarkers = markers;
	// Last range first, so earlier ranges keep their original coordinates.
	for (const range of normalizeRanges({ ranges }).reverse()) {
		const apply = <TTrack extends { clips: TimelineClip[] }>(track: TTrack): TTrack => ({
			...track,
			clips: rippleDeleteClips({ clips: track.clips, range, generateId }),
		});
		nextTracks = {
			main: apply(nextTracks.main),
			overlay: nextTracks.overlay.map(apply),
			audio: nextTracks.audio.map(apply),
		};
		const length = subMediaTime({ a: range.end, b: range.start });
		nextMarkers = nextMarkers.flatMap((marker): Marker[] => {
			if (marker.time < range.start) return [marker];
			if (marker.time < range.end)
				return marker.data ? [{ ...marker, time: range.start }] : [];
			return [{ ...marker, time: subMediaTime({ a: marker.time, b: length }) }];
		});
	}
	return { tracks: nextTracks, markers: nextMarkers };
}
