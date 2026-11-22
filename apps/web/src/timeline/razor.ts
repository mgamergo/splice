import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import { isRetimableClip } from "@/timeline";
import type { TimelineClip } from "@/timeline";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
} from "@/wasm";

/**
 * Cuts one clip in two at a sequence time. Returns null when the time isn't
 * strictly inside the clip. The left half keeps the clip's id; the right half
 * gets `rightClipId`.
 */
export function razorClip<TClip extends TimelineClip>({
	clip,
	at,
	rightClipId,
}: {
	clip: TClip;
	at: MediaTime;
	rightClipId: string;
}): { left: TClip; right: TClip } | null {
	const clipEnd = addMediaTime({ a: clip.startTime, b: clip.duration });
	if (at <= clip.startTime || at >= clipEnd) {
		return null;
	}

	const leftVisibleDuration = subMediaTime({ a: at, b: clip.startTime });
	const rightVisibleDuration = subMediaTime({
		a: clip.duration,
		b: leftVisibleDuration,
	});
	const retime = isRetimableClip(clip) ? clip.retime : undefined;
	// Snap the source-side cut once and derive the right half from it, so that
	// leftSourceSpan + rightSourceSpan always equals the total source span.
	const leftSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({ clipTime: leftVisibleDuration, retime }),
	});
	const totalSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({ clipTime: clip.duration, retime }),
	});
	const rightSourceSpan = subMediaTime({ a: totalSourceSpan, b: leftSourceSpan });
	const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
		animations: clip.animations,
		splitTime: leftVisibleDuration,
		shouldIncludeSplitBoundary: true,
	});

	return {
		left: {
			...clip,
			duration: leftVisibleDuration,
			trimEnd: addMediaTime({ a: clip.trimEnd, b: rightSourceSpan }),
			animations: leftAnimations,
		},
		right: {
			...clip,
			id: rightClipId,
			startTime: at,
			duration: rightVisibleDuration,
			trimStart: addMediaTime({ a: clip.trimStart, b: leftSourceSpan }),
			animations: rightAnimations,
		},
	};
}
