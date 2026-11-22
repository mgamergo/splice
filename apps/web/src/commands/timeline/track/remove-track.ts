import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SequenceTracks } from "@/timeline";

export class RemoveTrackCommand extends Command {
	private savedState: SequenceTracks | null = null;

	constructor(private trackId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;
		const updatedTracks: SequenceTracks = {
			...this.savedState,
			overlay: this.savedState.overlay.filter((track) => track.id !== this.trackId),
			audio: this.savedState.audio.filter((track) => track.id !== this.trackId),
		};
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
