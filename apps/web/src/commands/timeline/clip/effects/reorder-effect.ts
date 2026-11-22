import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { isVisualClip, updateClipInSequenceTracks } from "@/timeline";
import type { SequenceTracks, VisualClip } from "@/timeline";

function reorderEffectsOnClip({
	clip,
	fromIndex,
	toIndex,
}: {
	clip: VisualClip;
	fromIndex: number;
	toIndex: number;
}): VisualClip {
	const effects = [...(clip.effects ?? [])];
	const [moved] = effects.splice(fromIndex, 1);
	effects.splice(toIndex, 0, moved);
	return { ...clip, effects };
}

export class ReorderClipEffectsCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly fromIndex: number;
	private readonly toIndex: number;

	constructor({
		trackId,
		clipId,
		fromIndex,
		toIndex,
	}: {
		trackId: string;
		clipId: string;
		fromIndex: number;
		toIndex: number;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.fromIndex = fromIndex;
		this.toIndex = toIndex;
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
			return reorderEffectsOnClip({
				clip: clip as VisualClip,
				fromIndex: this.fromIndex,
				toIndex: this.toIndex,
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
