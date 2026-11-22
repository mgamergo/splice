import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { Marker, TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";

/** Adds a marker. Unlike ToggleMarkerCommand, it never removes one. */
export class AddMarkerCommand extends Command {
	private savedSequences: TSequence[] | null = null;

	constructor(private readonly marker: Marker) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const sequence = editor.sequences.getActiveSequence();
		const sequences = editor.sequences.getSequences();
		this.savedSequences = sequences;
		const markers = [...sequence.markers, this.marker].sort((a, b) => a.time - b.time);
		editor.sequences.setSequences({
			sequences: updateSequenceInArray({
				sequences,
				sequenceId: sequence.id,
				updates: { markers },
			}),
		});
		return undefined;
	}

	undo(): void {
		if (this.savedSequences) {
			EditorCore.getInstance().sequences.setSequences({
				sequences: this.savedSequences,
			});
		}
	}
}
