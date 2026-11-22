import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { isVisualClip, updateClipInSequenceTracks } from "@/timeline";
import type { SequenceTracks, VisualClip } from "@/timeline";

function removeEffectFromClip({
	clip,
	effectId,
}: {
	clip: VisualClip;
	effectId: string;
}): VisualClip {
	const currentEffects = clip.effects ?? [];
	const filtered = currentEffects.filter((effect) => effect.id !== effectId);
	return { ...clip, effects: filtered };
}

export class RemoveClipEffectCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly effectId: string;

	constructor({
		trackId,
		clipId,
		effectId,
	}: {
		trackId: string;
		clipId: string;
		effectId: string;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.effectId = effectId;
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
			return removeEffectFromClip({
				clip: clip as VisualClip,
				effectId: this.effectId,
			});
			},
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
