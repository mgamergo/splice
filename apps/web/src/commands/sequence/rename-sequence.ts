import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";

export class RenameSequenceCommand extends Command {
	private savedSequences: TSequence[] | null = null;
	private previousName: string | null = null;

	constructor({
		sequenceId,
		newName,
	}: {
		sequenceId: string;
		newName: string;
	}) {
		super();
		this.sequenceId = sequenceId;
		this.newName = newName;
	}

	private sequenceId: string;
	private newName: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const sequences = editor.sequences.getSequences();

		this.savedSequences = [...sequences];

		const sequence = sequences.find((s) => s.id === this.sequenceId);
		if (!sequence) {
			console.error("Sequence not found:", this.sequenceId);
			return;
		}

		this.previousName = sequence.name;

		const updatedSequences = updateSequenceInArray({
			sequences,
			sequenceId: this.sequenceId,
			updates: { name: this.newName, updatedAt: new Date() },
		});

		editor.sequences.setSequences({ sequences: updatedSequences });
	}

	undo(): void {
		if (this.savedSequences && this.previousName !== null) {
			const editor = EditorCore.getInstance();
			editor.sequences.setSequences({ sequences: this.savedSequences });
		}
	}
}
