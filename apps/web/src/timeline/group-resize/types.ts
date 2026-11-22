import type { FrameRate } from "opencut-wasm";
import type { ClipRef, RetimeConfig } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

export type ResizeSide = "left" | "right";

export interface GroupResizeMember extends ClipRef {
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	retime?: RetimeConfig;
	leftNeighborBound: MediaTime | null;
	rightNeighborBound: MediaTime | null;
}

export interface GroupResizeUpdate extends ClipRef {
	patch: {
		trimStart: MediaTime;
		trimEnd: MediaTime;
		startTime: MediaTime;
		duration: MediaTime;
	};
}

export interface GroupResizeResult {
	deltaTime: MediaTime;
	updates: GroupResizeUpdate[];
}

export interface ComputeGroupResizeArgs {
	members: GroupResizeMember[];
	side: ResizeSide;
	deltaTime: MediaTime;
	fps: FrameRate;
}
