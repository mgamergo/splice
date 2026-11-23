import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { Marker, SequenceTracks, TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";

/** Adds a marker. Unlike ToggleMarkerCommand, it never removes one. */
export class AddMarkerCommand extends Command {
	private savedSequences: TSequence[] | null = null;

	constructor(
		private readonly options: { marker: Marker; tracks?: SequenceTracks },
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const sequence = editor.sequences.getActiveSequence();
		const sequences = editor.sequences.getSequences();
		this.savedSequences = sequences;
		const { marker, tracks = sequence.tracks } = this.options;
		const markers = [...sequence.markers, marker].sort(
			(a, b) => a.time - b.time,
		);
		editor.sequences.setSequences({
			sequences: updateSequenceInArray({
				sequences,
				sequenceId: sequence.id,
				updates: { markers, tracks },
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
