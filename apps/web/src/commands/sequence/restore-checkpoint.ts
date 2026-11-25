import type { ApprovedCheckpoint } from "@/approval/types";
import { Command, createClipSelectionResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import { requireSequenceMedia } from "@/media/sequence-media";
import type { TProject } from "@/project/types";
import type { TSequence } from "@/timeline";
import { updateSequenceInArray } from "@/timeline/sequences";

/**
 * Puts an approved checkpoint's edit back on its sequence, with the captions
 * it was approved with, as one new undoable edit. Undo history before it is
 * untouched, and so are checkpoints and dismissals.
 */
export class RestoreCheckpointCommand extends Command {
	readonly ignoresRippleToggle = true;
	private before: {
		sequences: TSequence[];
		captions: TProject["captions"];
		background: TProject["settings"]["background"];
	} | null = null;

	constructor(
		private readonly options: {
			editor: EditorCore;
			checkpoint: ApprovedCheckpoint;
		},
	) {
		super();
	}

	get label(): string {
		return "Return to approved cut";
	}

	execute() {
		const { editor, checkpoint } = this.options;
		requireSequenceMedia({
			tracks: checkpoint.tracks,
			projectItems: editor.media.getProjectItems(),
		});
		const project = editor.project.getActive();
		const sequences = editor.sequences.getSequences();
		this.before = {
			sequences,
			captions: project.captions,
			background: project.settings.background,
		};
		editor.sequences.setSequences({
			sequences: updateSequenceInArray({
				sequences,
				sequenceId: checkpoint.sequenceId,
				updates: {
					tracks: structuredClone(checkpoint.tracks),
					markers: structuredClone(checkpoint.markers),
					captions: checkpoint.sequenceCaptions
						? structuredClone(checkpoint.sequenceCaptions)
						: undefined,
				},
			}),
		});
		const current = editor.project.getActive();
		editor.project.setActiveProject({
			project: {
				...current,
				captions: structuredClone(checkpoint.captions),
				settings: {
					...current.settings,
					background: structuredClone(checkpoint.background),
				},
			},
		});
		editor.save.markDirty();
		return createClipSelectionResult([]);
	}

	undo(): void {
		const { editor } = this.options;
		if (!this.before) return;
		editor.sequences.setSequences({ sequences: this.before.sequences });
		editor.project.setActiveProject({
			project: {
				...editor.project.getActive(),
				captions: this.before.captions,
				settings: {
					...editor.project.getActive().settings,
					background: this.before.background,
				},
			},
		});
		editor.save.markDirty();
	}
}
