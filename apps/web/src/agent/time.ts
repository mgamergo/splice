import type { FrameRate } from "opencut-wasm";
import type { TimeRange } from "@/timeline/ripple-delete";
import type { TimeSpec } from "@splice/bridge/ops";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	parseMediaTimecode,
	roundFrameTime,
	roundMediaTime,
	TICKS_PER_SECOND,
} from "@/wasm";

export class TimeSpecError extends Error {}

function timeSpecTicks({
	spec,
	fps,
}: {
	spec: TimeSpec;
	fps: FrameRate;
}): MediaTime {
	if ("seconds" in spec) return mediaTimeFromSeconds({ seconds: spec.seconds });
	if ("frame" in spec) {
		return mediaTimeFromSeconds({
			seconds: (spec.frame * fps.denominator) / fps.numerator,
		});
	}
	const parsed = parseMediaTimecode({
		timeCode: spec.timecode,
		format: "HH:MM:SS:FF",
		fps,
	});
	if (parsed === null) {
		throw new TimeSpecError(`Invalid timecode "${spec.timecode}" (expected HH:MM:SS:FF)`);
	}
	return parsed;
}

/** Converts a timeline edit time to ticks on the nearest frame boundary. */
export function resolveTimeSpec({
	spec,
	fps,
}: {
	spec: TimeSpec;
	fps: FrameRate;
}): MediaTime {
	return roundFrameTime({ time: timeSpecTicks({ spec, fps }), fps });
}

/** Snap the start down and end up on the same frame grid used by edit ops. */
export function resolveEditRange({
	start,
	end,
	fps,
}: {
	start: TimeSpec;
	end: TimeSpec;
	fps: FrameRate;
}): TimeRange {
	const from = timeSpecTicks({ spec: start, fps });
	const to = timeSpecTicks({ spec: end, fps });
	if (to <= from)
		throw new TimeSpecError("The scope end must be after its start.");
	const first = roundFrameTime({ time: from, fps });
	const last = roundFrameTime({ time: to, fps });
	const frameTicks = (TICKS_PER_SECOND * fps.denominator) / fps.numerator;
	return {
		start:
			first <= from
				? first
				: roundFrameTime({
						time: roundMediaTime({ time: first - frameTicks }),
						fps,
					}),
		end:
			last >= to
				? last
				: roundFrameTime({
						time: roundMediaTime({ time: last + frameTicks }),
						fps,
					}),
	};
}

export function formatSeconds({ time }: { time: MediaTime }): string {
	return mediaTimeToSeconds({ time }).toFixed(2);
}
