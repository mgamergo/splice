import type { CorrectionEdit } from "@splice/bridge/profile";
import type { EditorSelectionPatch } from "@/selection/editor-selection";
import type { ClipRef } from "@/timeline/types";

export interface CommandResult {
	selection?: EditorSelectionPatch;
	corrections?: CorrectionEdit[];
}

export function createClipSelectionResult(
	selectedClips: ClipRef[],
): CommandResult {
	return {
		selection: {
			selectedClips,
			selectedKeyframes: [],
			keyframeSelectionAnchor: null,
			selectedMaskPoints: null,
		},
	};
}

export abstract class Command {
	/** When true, CommandManager never applies ripple adjustments to this command. */
	readonly ignoresRippleToggle: boolean = false;

	readonly isAgentEdit: boolean = false;

	abstract execute(): CommandResult | undefined;

	undo(): void {
		throw new Error("Undo not implemented for this command");
	}

	redo(): CommandResult | undefined {
		return this.execute();
	}
}
