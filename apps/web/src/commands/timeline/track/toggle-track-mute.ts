import { Command, type CommandResult } from "@/commands/base-command";
import type { SequenceTracks } from "@/timeline";
import { EditorCore } from "@/core";
import { canTrackHaveAudio, findTrackInSequenceTracks, updateTrackInSequenceTracks } from "@/timeline";

export class ToggleTrackMuteCommand extends Command {
	private savedState: SequenceTracks | null = null;

	constructor(private trackId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const targetTrack = findTrackInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
		});
		if (!targetTrack) {
			return;
		}

		const updatedTracks = updateTrackInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			update: (track) =>
				canTrackHaveAudio(track) ? { ...track, muted: !track.muted } : track,
		});

		editor.timeline.updateTracks(updatedTracks);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
