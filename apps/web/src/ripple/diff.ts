import type { SequenceTracks, TimelineClip, TimelineTrack } from "@/timeline/types";
import type { RippleAdjustment } from "./apply";

interface Interval {
	startTime: number;
	endTime: number;
}

interface ClipSpan extends Interval {
	id: string;
}

export function computeRippleAdjustments({
	beforeTracks,
	afterTracks,
}: {
	beforeTracks: SequenceTracks;
	afterTracks: SequenceTracks;
}): RippleAdjustment[] {
	const beforeTrackList = [
		...beforeTracks.overlay,
		beforeTracks.main,
		...beforeTracks.audio,
	];
	const afterTrackList = [
		...afterTracks.overlay,
		afterTracks.main,
		...afterTracks.audio,
	];
	const afterTracksById = new Map(afterTrackList.map((track) => [track.id, track]));
	const allAfterClipIds = new Set(
		afterTrackList.flatMap((track) => track.clips.map((clip) => clip.id)),
	);

	return beforeTrackList.flatMap((beforeTrack): RippleAdjustment[] =>
		computeTrackRippleAdjustments({
			trackId: beforeTrack.id,
			beforeClips: beforeTrack.clips,
			afterClips: afterTracksById.get(beforeTrack.id)?.clips ?? [],
			allAfterClipIds,
		}),
	);
}

function computeTrackRippleAdjustments({
	trackId,
	beforeClips,
	afterClips,
	allAfterClipIds,
}: {
	trackId: string;
	beforeClips: TimelineClip[];
	afterClips: TimelineClip[];
	allAfterClipIds: Set<string>;
}): RippleAdjustment[] {
	const beforeClipsById = buildClipSpanMap({ clips: beforeClips });
	const afterClipsById = buildClipSpanMap({ clips: afterClips });
	const { vacatedIntervals, joinedIntervals } = collectTrackIntervals({
		beforeClipsById,
		afterClipsById,
		allAfterClipIds,
	});
	const freedIntervals = subtractIntervalSets({
		sourceIntervals: vacatedIntervals,
		overlappingIntervals: joinedIntervals,
	});

	return buildAdjustments({ trackId, intervals: freedIntervals });
}

function buildClipSpanMap({
	clips,
}: {
	clips: TimelineClip[];
}): Map<string, ClipSpan> {
	return new Map(
		clips.map((clip) => [
			clip.id,
			{
				id: clip.id,
				startTime: clip.startTime,
				endTime: clip.startTime + clip.duration,
			},
		]),
	);
}

function collectTrackIntervals({
	beforeClipsById,
	afterClipsById,
	allAfterClipIds,
}: {
	beforeClipsById: Map<string, ClipSpan>;
	afterClipsById: Map<string, ClipSpan>;
	allAfterClipIds: Set<string>;
}): {
	vacatedIntervals: Interval[];
	joinedIntervals: Interval[];
} {
	const vacatedIntervals: Interval[] = [];
	const joinedIntervals: Interval[] = [];

	for (const beforeClip of beforeClipsById.values()) {
		const afterClip = afterClipsById.get(beforeClip.id);
		if (!afterClip) {
			const wasMovedToAnotherTrack = allAfterClipIds.has(beforeClip.id);
			if (!wasMovedToAnotherTrack) {
				pushInterval({
					intervals: vacatedIntervals,
					startTime: beforeClip.startTime,
					endTime: beforeClip.endTime,
				});
			}
			continue;
		}

		if (beforeClip.endTime > afterClip.endTime) {
			pushInterval({
				intervals: vacatedIntervals,
				startTime: afterClip.endTime,
				endTime: beforeClip.endTime,
			});
		}
	}

	for (const afterClip of afterClipsById.values()) {
		if (beforeClipsById.has(afterClip.id)) {
			continue;
		}

		pushInterval({
			intervals: joinedIntervals,
			startTime: afterClip.startTime,
			endTime: afterClip.endTime,
		});
	}

	return {
		vacatedIntervals: normalizeIntervals({ intervals: vacatedIntervals }),
		joinedIntervals: normalizeIntervals({ intervals: joinedIntervals }),
	};
}

function buildAdjustments({
	trackId,
	intervals,
}: {
	trackId: string;
	intervals: Interval[];
}): RippleAdjustment[] {
	return intervals.flatMap((interval): RippleAdjustment[] => {
		const shiftAmount = interval.endTime - interval.startTime;
		if (shiftAmount <= 0) {
			return [];
		}

		return [
			{
				trackId,
				afterTime: interval.endTime,
				shiftAmount,
			},
		];
	});
}

function subtractIntervalSets({
	sourceIntervals,
	overlappingIntervals,
}: {
	sourceIntervals: Interval[];
	overlappingIntervals: Interval[];
}): Interval[] {
	const normalizedSourceIntervals = normalizeIntervals({
		intervals: sourceIntervals,
	});
	const normalizedOverlappingIntervals = normalizeIntervals({
		intervals: overlappingIntervals,
	});

	return normalizedSourceIntervals.flatMap((sourceInterval) =>
		subtractSingleInterval({
			sourceInterval,
			overlappingIntervals: normalizedOverlappingIntervals,
		}),
	);
}

function normalizeIntervals({
	intervals,
}: {
	intervals: Interval[];
}): Interval[] {
	const validIntervals: Interval[] = [];
	for (const interval of intervals) {
		pushInterval({
			intervals: validIntervals,
			startTime: interval.startTime,
			endTime: interval.endTime,
		});
	}

	const sortedIntervals = validIntervals.sort(
		(leftInterval, rightInterval) =>
			leftInterval.startTime - rightInterval.startTime,
	);

	if (sortedIntervals.length === 0) {
		return [];
	}

	const mergedIntervals: Interval[] = [{ ...sortedIntervals[0] }];
	for (const interval of sortedIntervals.slice(1)) {
		const previousInterval = mergedIntervals[mergedIntervals.length - 1];
		if (interval.startTime <= previousInterval.endTime) {
			previousInterval.endTime = Math.max(
				previousInterval.endTime,
				interval.endTime,
			);
			continue;
		}

		mergedIntervals.push({ ...interval });
	}

	return mergedIntervals;
}

function subtractSingleInterval({
	sourceInterval,
	overlappingIntervals,
}: {
	sourceInterval: Interval;
	overlappingIntervals: Interval[];
}): Interval[] {
	let remainingIntervals: Interval[] = [{ ...sourceInterval }];

	for (const overlappingInterval of overlappingIntervals) {
		remainingIntervals = remainingIntervals.flatMap((remainingInterval) => {
		if (
			overlappingInterval.endTime <= remainingInterval.startTime ||
			overlappingInterval.startTime >= remainingInterval.endTime
		) {
				return [remainingInterval];
			}

			const nextIntervals: Interval[] = [];
			pushInterval({
				intervals: nextIntervals,
				startTime: remainingInterval.startTime,
				endTime: overlappingInterval.startTime,
			});
			pushInterval({
				intervals: nextIntervals,
				startTime: overlappingInterval.endTime,
				endTime: remainingInterval.endTime,
			});
			return nextIntervals;
		});

		if (remainingIntervals.length === 0) {
			return [];
		}
	}

	return remainingIntervals;
}

function pushInterval({
	intervals,
	startTime,
	endTime,
}: { intervals: Interval[]; startTime: number; endTime: number }): void {
	if (endTime <= startTime) {
		return;
	}

	intervals.push({ startTime, endTime });
}
