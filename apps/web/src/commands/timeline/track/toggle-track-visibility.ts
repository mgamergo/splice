import { Command, type CommandResult } from "@/commands/base-command";
import type { SequenceTracks } from "@/timeline";
import { EditorCore } from "@/core";
import { canTrackBeHidden, findTrackInSequenceTracks, updateTrackInSequenceTracks } from "@/timeline";

export class ToggleTrackVisibilityCommand extends Command {
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
			update: (track) => {
				if (canTrackBeHidden(track)) {
					return { ...track, hidden: !track.hidden };
				}
				return track;
			},
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
