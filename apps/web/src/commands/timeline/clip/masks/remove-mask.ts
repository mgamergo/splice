import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import { isMaskableClip, updateClipInSequenceTracks } from "@/timeline";
import type { SequenceTracks, MaskableClip } from "@/timeline";

function removeMaskFromClip({
	clip,
	maskId,
}: {
	clip: MaskableClip;
	maskId: string;
}): MaskableClip {
	const currentMasks = clip.masks ?? [];
	const filteredMasks = currentMasks.filter((mask) => mask.id !== maskId);
	return { ...clip, masks: filteredMasks };
}

export class RemoveMaskCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly maskId: string;

	constructor({
		trackId,
		clipId,
		maskId,
	}: {
		trackId: string;
		clipId: string;
		maskId: string;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.maskId = maskId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			clipPredicate: isMaskableClip,
			update: (clip) => {
				if (!isMaskableClip(clip)) return clip;
				return removeMaskFromClip({
					clip,
					maskId: this.maskId,
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
