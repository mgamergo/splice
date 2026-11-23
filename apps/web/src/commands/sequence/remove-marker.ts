import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";
import { removeMarkerFromArray } from "@/timeline/markers/index";
import type { MediaTime } from "@/wasm";

export class RemoveMarkerCommand extends Command {
	private savedSequences: TSequence[] | null = null;

	constructor(private time: MediaTime) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const activeSequence = editor.sequences.getActiveSequence();
		const sequences = editor.sequences.getSequences();
		this.savedSequences = [...sequences];

		const updatedMarkers = removeMarkerFromArray({
			markers: activeSequence.markers,
			time: this.time,
		});

		if (updatedMarkers.length === activeSequence.markers.length) {
			return;
		}

		const updatedSequences = updateSequenceInArray({
			sequences,
			sequenceId: activeSequence.id,
			updates: { markers: updatedMarkers },
		});

		editor.sequences.setSequences({ sequences: updatedSequences });
		return undefined;
	}

	undo(): void {
		if (this.savedSequences) {
			const editor = EditorCore.getInstance();
			editor.sequences.setSequences({ sequences: this.savedSequences });
		}
	}
}
