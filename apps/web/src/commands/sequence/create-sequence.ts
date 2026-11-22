import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";

export class CreateSequenceCommand extends Command {
	private savedSequences: TSequence[] | null = null;
	private createdSequence: TSequence | null = null;

	constructor({
		name,
		isMain = false,
	}: {
		name: string;
		isMain?: boolean;
	}) {
		super();
		this.name = name;
		this.isMain = isMain;
	}

	private name: string;
	private isMain: boolean;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedSequences = [...editor.sequences.getSequences()];

		this.createdSequence = buildDefaultSequence({
			name: this.name,
			isMain: this.isMain,
		});

		const updatedSequences = [...this.savedSequences, this.createdSequence];
		editor.sequences.setSequences({ sequences: updatedSequences });
		return undefined;
	}

	undo(): void {
		if (this.savedSequences) {
			const editor = EditorCore.getInstance();
			editor.sequences.setSequences({ sequences: this.savedSequences });
		}
	}

	getSequenceId(): string {
		return this.createdSequence?.id ?? "";
	}
}
