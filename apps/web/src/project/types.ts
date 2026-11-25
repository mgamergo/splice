import type { StyleDefaults } from "@splice/bridge/style";
import type { FrameRate } from "opencut-wasm";
import type { ProjectFormat, ShortStyle } from "@splice/bridge";
import type { ProjectBrief } from "@splice/bridge/brief";
import type { ProjectCaptions } from "@splice/bridge/delivery";
import type { ProjectApproval } from "@/approval/types";
import type { TSequence } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export interface TProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: MediaTime;
	createdAt: Date;
	updatedAt: Date;
}

export interface TProjectSettings {
	/** Chosen at creation. Projects saved before formats existed are horizontal. */
	format?: ProjectFormat;
	shortStyle?: ShortStyle;
	styleDefaults?: StyleDefaults;
	fps: FrameRate;
	canvasSize: TCanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: TCanvasSize | null;
	originalCanvasSize?: TCanvasSize | null;
	background: TBackground;
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: MediaTime;
}

export interface TProject {
	metadata: TProjectMetadata;
	sequences: TSequence[];
	currentSequenceId: string;
	settings: TProjectSettings;
	version: number;
	brief?: ProjectBrief;
	timelineViewState?: TTimelineViewState;
	/** Horizontal projects: the transcript words and corrections SRT captions come from. */
	captions?: ProjectCaptions;
	/** Approved checkpoints and dismissed review issues. */
	approval?: ProjectApproval;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
