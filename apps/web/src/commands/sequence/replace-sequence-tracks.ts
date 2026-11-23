import { Command, createClipSelectionResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import type { SequenceTracks, TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";

/** Swaps in a sequence's rebuilt tracks as one undoable command. */
export class ReplaceSequenceTracksCommand extends Command {
	readonly ignoresRippleToggle = true;
	private before: TSequence[] = [];

	constructor(
		private readonly options: {
			editor: EditorCore;
			sequenceId: string;
			tracks: SequenceTracks;
			label: string;
		},
	) {
		super();
	}

	get label(): string {
		return this.options.label;
	}

	execute() {
		const { editor, sequenceId, tracks } = this.options;
		this.before = editor.sequences.getSequences();
		editor.sequences.setSequences({
			sequences: updateSequenceInArray({
				sequences: this.before,
				sequenceId,
				updates: { tracks },
			}),
		});
		return createClipSelectionResult([]);
	}

	undo(): void {
		this.options.editor.sequences.setSequences({ sequences: this.before });
	}
}
