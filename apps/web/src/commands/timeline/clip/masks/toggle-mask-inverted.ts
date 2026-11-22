import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import { isMaskableClip, updateClipInSequenceTracks } from "@/timeline";
import type { Mask } from "@/masks/types";
import type { SequenceTracks, MaskableClip } from "@/timeline";

export function toggleMaskInvertedOnClip({
	clip,
	maskId,
}: {
	clip: MaskableClip;
	maskId: string;
}): MaskableClip {
	const currentMasks = clip.masks ?? [];
	const toggleMask = <TMask extends Mask>(mask: TMask): TMask => ({
		...mask,
		params: {
			...mask.params,
			inverted: !mask.params.inverted,
		},
	});
	const updatedMasks = currentMasks.map((mask) =>
		mask.id !== maskId ? mask : toggleMask(mask),
	);

	return { ...clip, masks: updatedMasks };
}

export class ToggleMaskInvertedCommand extends Command {
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
				return toggleMaskInvertedOnClip({
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
