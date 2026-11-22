import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";
import {
	getFrameTime,
	removeMarkerFromArray,
} from "@/timeline/markers/index";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export class RemoveMarkerCommand extends Command {
	private savedSequences: TSequence[] | null = null;
	private frameTime: MediaTime = ZERO_MEDIA_TIME;

	constructor(private time: MediaTime) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const activeSequence = editor.sequences.getActiveSequence();
		const activeProject = editor.project.getActive();

		if (!activeSequence || !activeProject) {
			return;
		}

		const sequences = editor.sequences.getSequences();
		this.savedSequences = [...sequences];

		this.frameTime = getFrameTime({
			time: this.time,
			fps: activeProject.settings.fps,
		});

		const updatedMarkers = removeMarkerFromArray({
			markers: activeSequence.markers,
			frameTime: this.frameTime,
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
	}

	undo(): void {
		if (this.savedSequences) {
			const editor = EditorCore.getInstance();
			editor.sequences.setSequences({ sequences: this.savedSequences });
		}
	}
}
