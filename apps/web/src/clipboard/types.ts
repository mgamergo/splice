import type { EditorCore } from "@/core";
import type {
	AnimationInterpolation,
	AnimationPath,
	ScalarCurveKeyframePatch,
	SelectedKeyframeRef,
} from "@/animation/types";
import type { ParamValue } from "@/params";
import type { Command } from "@/commands/base-command";
import type {
	CreateTimelineClip,
	ClipRef,
	TrackType,
} from "@/timeline";
import type { MediaTime } from "@/wasm";

export interface ClipClipboardItem {
	trackId: string;
	trackType: TrackType;
	clip: CreateTimelineClip;
}

export interface KeyframeClipboardCurvePatch {
	componentKey: string;
	patch: ScalarCurveKeyframePatch;
}

export interface KeyframeClipboardItem {
	propertyPath: AnimationPath;
	timeOffset: MediaTime;
	value: ParamValue;
	interpolation: AnimationInterpolation;
	curvePatches: KeyframeClipboardCurvePatch[];
}

export interface ClipsClipboardEntry {
	type: "clips";
	items: ClipClipboardItem[];
}

export interface KeyframesClipboardEntry {
	type: "keyframes";
	sourceClip: ClipRef;
	items: KeyframeClipboardItem[];
}

export interface ClipboardEntryByType {
	clips: ClipsClipboardEntry;
	keyframes: KeyframesClipboardEntry;
}

export type ClipboardEntry = ClipboardEntryByType[keyof ClipboardEntryByType];
export type ClipboardEntryType = keyof ClipboardEntryByType;

export interface CopyContext {
	editor: EditorCore;
	selectedClips: ClipRef[];
	selectedKeyframes: SelectedKeyframeRef[];
}

export interface PasteContext {
	editor: EditorCore;
	selectedClips: ClipRef[];
	selectedKeyframes: SelectedKeyframeRef[];
	time: MediaTime;
}

export interface ClipboardHandler<TType extends ClipboardEntryType> {
	type: TType;
	canCopy(context: CopyContext): boolean;
	copy(context: CopyContext): ClipboardEntryByType[TType] | null;
	paste(args: {
		entry: ClipboardEntryByType[TType];
		context: PasteContext;
	}): Command | null;
}

export type ClipboardHandlerMap = {
	[TType in ClipboardEntryType]: ClipboardHandler<TType>;
};
