import type { CheckpointSummary, Dismissal } from "@splice/bridge/approval";
import type { ProjectCaptions } from "@splice/bridge/delivery";
import type { CaptionsRequest } from "@splice/bridge/ops";
import type { TBackground } from "@/project/types";
import type { Marker, SequenceTracks } from "@/timeline/types";

/** A recording as it was on disk when the cut was approved. */
export interface FootageIdentity {
	projectItemId: string;
	name: string;
	size: number;
	lastModified: number;
	path?: string;
	contentHash?: string;
	missing: boolean;
}

/**
 * The exact edit the creator approved: the sequence, the captions it was
 * reviewed with and the SRT they made, so it can be compared, played,
 * restored and exported later.
 */
export interface ApprovedCheckpoint extends CheckpointSummary {
	/** Without decoded audio buffers. */
	tracks: SequenceTracks;
	markers: Marker[];
	background: TBackground;
	/** A Short's burned-in captions. */
	sequenceCaptions?: CaptionsRequest;
	/** A Horizontal project's SRT words and corrections. */
	captions?: ProjectCaptions;
	srt: string;
	cues: Array<{
		id: string;
		start: number;
		end: number;
		text: string;
		correctedBy?: "cue" | "project" | "spelling";
	}>;
	footage: FootageIdentity[];
}

/** Saved with the project, outside the undo history and the Cache folder. */
export interface ProjectApproval {
	/** Oldest first. */
	checkpoints: ApprovedCheckpoint[];
	dismissals: Dismissal[];
}
