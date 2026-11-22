import type { MediaTime } from "@/wasm";

export type SnapPointType =
	| "clip-start"
	| "clip-end"
	| "playhead"
	| "marker"
	| "keyframe";

export interface SnapPoint {
	time: MediaTime;
	type: SnapPointType;
	clipId?: string;
	trackId?: string;
}

export interface SnapResult {
	snappedTime: MediaTime;
	snapPoint: SnapPoint | null;
	snapDistance: number;
}

export type TimelineSnapPointSource = () => Iterable<SnapPoint>;
