import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { Marker, TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";
import { updateMarkerInArray } from "@/timeline/markers/index";
import type { MediaTime } from "@/wasm";

export class UpdateMarkerCommand extends Command {
	private savedSequences: TSequence[] | null = null;

	constructor({
		time,
		updates,
	}: {
		time: MediaTime;
		updates: Partial<Pick<Marker, "note" | "color" | "duration">>;
	}) {
		super();
		this.time = time;
		this.updates = updates;
	}

	private time: MediaTime;
	private updates: Partial<Pick<Marker, "note" | "color" | "duration">>;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const activeSequence = editor.sequences.getActiveSequence();
		const sequences = editor.sequences.getSequences();
		this.savedSequences = [...sequences];

		const updatedMarkers = updateMarkerInArray({
			markers: activeSequence.markers,
			time: this.time,
			updates: this.updates,
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
