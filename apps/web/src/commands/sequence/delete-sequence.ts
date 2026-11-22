import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";
import { canDeleteSequence, getFallbackSequenceAfterDelete } from "@/timeline/sequences";

export class DeleteSequenceCommand extends Command {
	private savedSequences: TSequence[] | null = null;
	private savedActiveSequenceId: string | null = null;
	private deletedSequence: TSequence | null = null;

	constructor(private sequenceId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const sequences = editor.sequences.getSequences();
		const activeSequence = editor.sequences.getActiveSequence();

		this.savedSequences = [...sequences];
		this.savedActiveSequenceId = activeSequence?.id ?? null;

		this.deletedSequence = sequences.find((s) => s.id === this.sequenceId) ?? null;

		if (!this.deletedSequence) {
			console.error("Sequence not found:", this.sequenceId);
			return;
		}

		const { canDelete, reason } = canDeleteSequence({ sequence: this.deletedSequence });
		if (!canDelete) {
			console.error("Cannot delete sequence:", reason);
			return;
		}

		const updatedSequences = sequences.filter((s) => s.id !== this.sequenceId);

		const newActiveSequence = getFallbackSequenceAfterDelete({
			sequences: updatedSequences,
			deletedSequenceId: this.sequenceId,
			currentSequenceId: activeSequence?.id ?? null,
		});

		editor.sequences.setSequences({
			sequences: updatedSequences,
			activeSequenceId: newActiveSequence?.id,
		});
	}

	undo(): void {
		if (this.savedSequences && this.deletedSequence) {
			const editor = EditorCore.getInstance();
			editor.sequences.setSequences({
				sequences: this.savedSequences,
				activeSequenceId: this.savedActiveSequenceId ?? undefined,
			});
		}
	}
}
