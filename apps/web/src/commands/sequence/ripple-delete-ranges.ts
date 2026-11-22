import {
	Command,
	createClipSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TSequence } from "@/timeline";
import { rippleDeleteRanges, type TimeRange } from "@/timeline/ripple-delete";
import { updateSequenceInArray } from "@/timeline/sequences";
import { generateUUID } from "@/utils/id";

export class RippleDeleteRangesCommand extends Command {
	private savedSequences: TSequence[] | null = null;

	constructor(private readonly ranges: TimeRange[]) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const sequence = editor.sequences.getActiveSequence();
		const sequences = editor.sequences.getSequences();
		this.savedSequences = sequences;

		const result = rippleDeleteRanges({
			tracks: sequence.tracks,
			markers: sequence.markers,
			ranges: this.ranges,
			generateId: generateUUID,
		});
		editor.sequences.setSequences({
			sequences: updateSequenceInArray({
				sequences,
				sequenceId: sequence.id,
				updates: { tracks: result.tracks, markers: result.markers },
			}),
		});

		const remainingClipIds = new Set(
			[result.tracks.main, ...result.tracks.overlay, ...result.tracks.audio].flatMap((track) =>
				track.clips.map((clip) => clip.id),
			),
		);
		const selected = editor.selection.getSnapshot().selectedClips;
		const stillSelected = selected.filter((ref) => remainingClipIds.has(ref.clipId));
		if (stillSelected.length !== selected.length) {
			return createClipSelectionResult(stillSelected);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedSequences) {
			EditorCore.getInstance().sequences.setSequences({
				sequences: this.savedSequences,
			});
		}
	}
}
