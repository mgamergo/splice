import { Command, createClipSelectionResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";

/** Applies a rebuilt part of one sequence as one undoable command. */
export class UpdateSequenceCommand extends Command {
	readonly ignoresRippleToggle = true;
	private before: TSequence[] = [];

	constructor(
		private readonly options: {
			editor: EditorCore;
			sequenceId: string;
			updates: Partial<Pick<TSequence, "tracks" | "captions" | "graphics" | "mix" | "styleDefaults">>;
			label: string;
			/** Leave the selection alone, for updates that follow the creator's own edit. */
			keepSelection?: boolean;
		},
	) {
		super();
	}

	get label(): string {
		return this.options.label;
	}

	execute() {
		const { editor, sequenceId, updates } = this.options;
		this.before = editor.sequences.getSequences();
		editor.sequences.setSequences({
			sequences: updateSequenceInArray({
				sequences: this.before,
				sequenceId,
				updates,
			}),
		});
		return this.options.keepSelection ? undefined : createClipSelectionResult([]);
	}

	undo(): void {
		this.options.editor.sequences.setSequences({ sequences: this.before });
	}
}
