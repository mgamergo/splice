import { mediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";

export const DEFAULT_NEW_CLIP_DURATION = mediaTime({
	ticks: 5 * TICKS_PER_SECOND,
});

export function toClipDurationTicks({
	seconds,
}: {
	seconds: number | null | undefined;
}) {
	if (seconds == null) {
		return DEFAULT_NEW_CLIP_DURATION;
	}

	return mediaTimeFromSeconds({ seconds });
}
