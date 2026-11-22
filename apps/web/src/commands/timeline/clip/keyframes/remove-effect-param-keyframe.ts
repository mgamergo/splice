import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import { removeEffectParamKeyframe } from "@/animation/effect-param-channel";
import { updateClipInSequenceTracks } from "@/timeline";
import { isVisualClip } from "@/timeline/clip-utils";
import type { SequenceTracks } from "@/timeline";

export class RemoveEffectParamKeyframeCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly effectId: string;
	private readonly paramKey: string;
	private readonly keyframeId: string;

	constructor({
		trackId,
		clipId,
		effectId,
		paramKey,
		keyframeId,
	}: {
		trackId: string;
		clipId: string;
		effectId: string;
		paramKey: string;
		keyframeId: string;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.effectId = effectId;
		this.paramKey = paramKey;
		this.keyframeId = keyframeId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			clipPredicate: isVisualClip,
			update: (clip) => {
				const animations = removeEffectParamKeyframe({
					animations: clip.animations,
					effectId: this.effectId,
					paramKey: this.paramKey,
					keyframeId: this.keyframeId,
				});
				return { ...clip, animations };
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
