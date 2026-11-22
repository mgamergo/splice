import type { TimelineClip } from "@/timeline/types";

export function rippleShiftClips<TClip extends TimelineClip>({
	clips,
	afterTime,
	shiftAmount,
}: {
	clips: TClip[];
	afterTime: number;
	shiftAmount: number;
}): TClip[] {
	return clips.map((clip) =>
		clip.startTime >= afterTime
			? ({ ...clip, startTime: clip.startTime - shiftAmount } as TClip)
			: clip,
	);
}
