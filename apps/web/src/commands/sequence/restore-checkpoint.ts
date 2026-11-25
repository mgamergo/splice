import { BASE_STYLE } from "@splice/bridge/style";
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
		settings: TProject["settings"];
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
			settings: project.settings,
		};
		if (checkpoint.shortStyle)
			editor.project.buildShortStyleCommand({
				style: checkpoint.shortStyle,
				skipSequenceId: checkpoint.sequenceId,
			})?.execute();
		editor.sequences.setSequences({
			sequences: updateSequenceInArray({
				sequences: editor.sequences.getSequences(),
				sequenceId: checkpoint.sequenceId,
				updates: {
					tracks: structuredClone(checkpoint.tracks),
					styleDefaults: structuredClone(checkpoint.styleDefaults ?? BASE_STYLE),
					graphics: structuredClone(checkpoint.graphics),
					markers: structuredClone(checkpoint.markers),
					protectedSections: structuredClone(checkpoint.protectedSections),
					mix: structuredClone(checkpoint.mix),
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
					...structuredClone(checkpoint.shortFrame),
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
		const project = editor.project.getActive();
		const { settings } = this.before;
		const { checkpoint } = this.options;
		editor.project.setActiveProject({
			project: {
				...project,
				captions: this.before.captions,
				settings: {
					...project.settings,
					background: settings.background,
					...(checkpoint.shortStyle && { shortStyle: settings.shortStyle }),
					...(checkpoint.shortFrame && {
						canvasSize: settings.canvasSize,
						fps: settings.fps,
					}),
				},
			},
		});
		editor.save.markDirty();
	}
}
