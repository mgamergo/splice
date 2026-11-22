import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { isVisualClip, updateClipInSequenceTracks } from "@/timeline";
import type { ParamValues } from "@/params";
import type { SequenceTracks, VisualClip } from "@/timeline";

function updateEffectParamsOnClip({
	clip,
	effectId,
	params,
}: {
	clip: VisualClip;
	effectId: string;
	params: Partial<ParamValues>;
}): VisualClip {
	const currentEffects = clip.effects ?? [];
	const updated = currentEffects.map((effect) => {
		if (effect.id !== effectId) {
			return effect;
		}

		const nextParams = { ...effect.params };
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) {
				nextParams[key] = value;
			}
		}

		return { ...effect, params: nextParams };
	});
	return { ...clip, effects: updated };
}

export class UpdateClipEffectParamsCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly effectId: string;
	private readonly params: Partial<ParamValues>;

	constructor({
		trackId,
		clipId,
		effectId,
		params,
	}: {
		trackId: string;
		clipId: string;
		effectId: string;
		params: Partial<ParamValues>;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.effectId = effectId;
		this.params = params;
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
				return updateEffectParamsOnClip({
					clip: clip as VisualClip,
					effectId: this.effectId,
					params: this.params,
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
