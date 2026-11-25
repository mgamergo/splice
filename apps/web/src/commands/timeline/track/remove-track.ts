import { Command, type CommandResult } from "@/commands/base-command";
import { tombstoneGraphics } from "@/agent/graphics";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import { EditorCore } from "@/core";
import type { SequenceTracks } from "@/timeline";

export class RemoveTrackCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private deleteGraphics?: UpdateSequenceCommand;

	constructor(private trackId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const sequence = editor.sequences.getActiveSequence();
		this.savedState = sequence.tracks;
		this.deleteGraphics = undefined;
		const updatedTracks: SequenceTracks = {
			...this.savedState,
			overlay: this.savedState.overlay.filter((track) => track.id !== this.trackId),
			audio: this.savedState.audio.filter((track) => track.id !== this.trackId),
		};
		const graphicIds = sequence.graphics
			? sequence.tracks.overlay.flatMap((track) =>
					track.clips.flatMap((clip) => track.id === this.trackId && clip.graphicId ? [clip.graphicId] : []),
				)
			: [];
		const graphics = tombstoneGraphics({ graphics: sequence.graphics, graphicIds });
		if (graphics !== sequence.graphics) {
			this.deleteGraphics = new UpdateSequenceCommand({
				editor,
				sequenceId: sequence.id,
				updates: { tracks: updatedTracks, graphics },
				label: "Delete graphics",
			});
			this.deleteGraphics.execute();
		} else {
			editor.timeline.updateTracks(updatedTracks);
		}
		return undefined;
	}

	undo(): void {
		if (this.deleteGraphics) {
			this.deleteGraphics.undo();
		} else if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
