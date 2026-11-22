import type { ClipRef, ClipType, TrackType } from "@/timeline";
import type { MediaTime } from "@/wasm";

export type GroupTrackSection = "overlay" | "main" | "audio";

export interface GroupMember extends ClipRef {
	clipType: ClipType;
	duration: MediaTime;
	timeOffset: MediaTime;
	trackSection: GroupTrackSection;
	sectionIndex: number;
	displayIndex: number;
}

export interface MoveGroup {
	anchor: GroupMember;
	members: GroupMember[];
}

export interface PlannedTrackCreation {
	id: string;
	type: TrackType;
	index: number;
}

export interface PlannedClipMove {
	sourceTrackId: string;
	targetTrackId: string;
	clipId: string;
	newStartTime: MediaTime;
}

export interface GroupMoveResult {
	moves: PlannedClipMove[];
	createTracks: PlannedTrackCreation[];
	targetSelection: ClipRef[];
}
