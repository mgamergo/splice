import { Command, createClipSelectionResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";

/** Publish the prepared sequence and select it in the same undoable command. */
export class AddPreparedSequenceCommand extends Command {
	readonly ignoresRippleToggle = true;
	private readonly before: { sequences: TSequence[]; activeSequenceId: string };

	constructor(
		private readonly options: {
			editor: EditorCore;
			sequence: TSequence;
			label: string;
		},
	) {
		super();
		this.before = {
			sequences: options.editor.sequences.getSequences(),
			activeSequenceId: options.editor.sequences.getActiveSequence().id,
		};
	}

	get label(): string {
		return this.options.label;
	}

	execute() {
		const { editor, sequence } = this.options;
		editor.sequences.setSequences({
			sequences: [...this.before.sequences, sequence],
			activeSequenceId: sequence.id,
		});
		return createClipSelectionResult([]);
	}

	undo(): void {
		this.options.editor.sequences.setSequences(this.before);
	}
}
