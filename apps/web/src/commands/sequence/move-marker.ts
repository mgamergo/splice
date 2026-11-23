import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";
import { moveMarkerInArray } from "@/timeline/markers/index";
import type { MediaTime } from "@/wasm";

export class MoveMarkerCommand extends Command {
	private savedSequences: TSequence[] | null = null;

	constructor(
		private readonly move: {
			fromTime: MediaTime;
			toTime: MediaTime;
			markerId?: string;
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const activeSequence = editor.sequences.getActiveSequence();
		const sequences = editor.sequences.getSequences();
		this.savedSequences = [...sequences];

		const updatedMarkers = moveMarkerInArray({
			markers: activeSequence.markers,
			...this.move,
		});

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
