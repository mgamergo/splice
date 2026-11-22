import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SequenceTracks, TimelineClip } from "@/timeline";
import {
	findTrackInSequenceTracks,
	updateClipInSequenceTracks,
} from "@/timeline";
import { applyClipUpdate } from "@/timeline/update-pipeline";

export class UpdateClipsCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly updates: Array<{
		trackId: string;
		clipId: string;
		patch: Partial<TimelineClip>;
	}>;

	constructor({
		updates,
	}: {
		updates: Array<{
			trackId: string;
			clipId: string;
			patch: Partial<TimelineClip>;
		}>;
	}) {
		super();
		this.updates = updates;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;
		let updatedTracks = this.savedState;

		for (const updateEntry of this.updates) {
			const currentTrack = findTrackInSequenceTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
			});
			const currentClip = currentTrack?.clips.find(
				(clip) => clip.id === updateEntry.clipId,
			);
			if (!currentTrack || !currentClip) {
				continue;
			}

			const nextClip = applyClipUpdate({
				clip: currentClip,
				patch: updateEntry.patch,
				context: {
					tracks: updatedTracks,
					trackId: updateEntry.trackId,
				},
			});

			updatedTracks = updateClipInSequenceTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
				clipId: updateEntry.clipId,
				update: () => nextClip,
			});
		}

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
