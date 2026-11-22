import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { isVisualClip, updateClipInSequenceTracks } from "@/timeline";
import type { SequenceTracks, VisualClip } from "@/timeline";
import { buildDefaultEffectInstance } from "@/effects";

function addEffectToClip({
	clip,
	effectType,
}: {
	clip: VisualClip;
	effectType: string;
}): VisualClip {
	const instance = buildDefaultEffectInstance({ effectType });
	const currentEffects = clip.effects ?? [];
	return { ...clip, effects: [...currentEffects, instance] };
}

export class AddClipEffectCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private effectId: string | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly effectType: string;

	constructor({
		trackId,
		clipId,
		effectType,
	}: {
		trackId: string;
		clipId: string;
		effectType: string;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.effectType = effectType;
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
			const updated = addEffectToClip({
				clip: clip as VisualClip,
				effectType: this.effectType,
			});
				const effects = updated.effects ?? [];
				this.effectId = effects[effects.length - 1]?.id ?? null;
				return updated;
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

	getEffectId(): string | null {
		return this.effectId;
	}
}
