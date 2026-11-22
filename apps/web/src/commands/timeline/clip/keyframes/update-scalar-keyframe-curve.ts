import { EditorCore } from "@/core";
import {
	updateScalarKeyframeCurve,
} from "@/animation";
import { Command, type CommandResult } from "@/commands/base-command";
import { updateClipInSequenceTracks } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type {
	AnimationPath,
	ScalarCurveKeyframePatch,
} from "@/animation/types";
import type { SequenceTracks } from "@/timeline";

export class UpdateScalarKeyframeCurveCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly propertyPath: AnimationPath;
	private readonly componentKey: string;
	private readonly keyframeId: string;
	private readonly patch: ScalarCurveKeyframePatch;

	constructor({
		trackId,
		clipId,
		propertyPath,
		componentKey,
		keyframeId,
		patch,
	}: {
		trackId: string;
		clipId: string;
		propertyPath: AnimationPath;
		componentKey: string;
		keyframeId: string;
		patch: ScalarCurveKeyframePatch;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.propertyPath = propertyPath;
		this.componentKey = componentKey;
		this.keyframeId = keyframeId;
		this.patch = patch;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			update: (clip) => {
				if (!resolveAnimationTarget({ clip, path: this.propertyPath })) {
					return clip;
				}

				return {
					...clip,
					animations: updateScalarKeyframeCurve({
						animations: clip.animations,
						propertyPath: this.propertyPath,
						componentKey: this.componentKey,
						keyframeId: this.keyframeId,
						patch: this.patch,
					}),
				};
			},
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}
