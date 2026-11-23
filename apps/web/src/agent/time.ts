import type { FrameRate } from "opencut-wasm";
import type { TimeSpec } from "@splice/bridge/ops";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	parseMediaTimecode,
	roundFrameTime,
} from "@/wasm";

export class TimeSpecError extends Error {}

/** Converts an agent time to ticks, snapped to the nearest frame. */
export function resolveTimeSpec({
	spec,
	fps,
}: {
	spec: TimeSpec;
	fps: FrameRate;
}): MediaTime {
	if ("seconds" in spec) {
		return roundFrameTime({ time: mediaTimeFromSeconds({ seconds: spec.seconds }), fps });
	}
	if ("frame" in spec) {
		const seconds = (spec.frame * fps.denominator) / fps.numerator;
		return roundFrameTime({ time: mediaTimeFromSeconds({ seconds }), fps });
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

export function formatSeconds({ time }: { time: MediaTime }): string {
	return mediaTimeToSeconds({ time }).toFixed(2);
}
