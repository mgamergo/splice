import type { ReviewIssue } from "@splice/bridge/approval";
import type { Replacement } from "@splice/bridge/delivery";
import type { CaptionCue } from "@/captions/cues";
import { sequenceCaptionCues } from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import { projectFormat } from "@/project/format";
import type { TSequence } from "@/timeline/types";
import { approvedEdit, latestCheckpoint, projectApproval } from "./checkpoint";
import { type CheckpointComparison, compareEdits } from "./compare";
import { applyDismissals, collectIssues } from "./issues";
import type { ApprovedCheckpoint } from "./types";

/** A sequence's approval state: its last checkpoint, what changed since, and what to review. */
export interface ReviewState {
	sequence: TSequence;
	checkpoint?: ApprovedCheckpoint;
	comparison?: CheckpointComparison;
	/** Every issue, dismissed ones marked. */
	issues: ReviewIssue[];
	unresolved: ReviewIssue[];
}

export function reviewState({
	editor,
	sequence = editor.sequences.getActiveSequence(),
	checkpoint,
	spellings = useCaptionsStore.getState().spellings,
	cues: reviewedCues,
}: {
	editor: EditorCore;
	sequence?: TSequence;
	/** Compare with this checkpoint instead of the sequence's last one. */
	checkpoint?: ApprovedCheckpoint;
	spellings?: Replacement[];
	cues?: CaptionCue[];
}): ReviewState {
	const project = editor.project.getActive();
	const horizontal = projectFormat({ project }) === "horizontal";
	const approved =
		checkpoint ?? latestCheckpoint({ project, sequenceId: sequence.id });
	const cues = horizontal
		? (reviewedCues ?? sequenceCaptionCues({ editor, sequence, spellings }))
		: [];
	const comparison = approved
		? compareEdits({
				approved: approvedEdit(approved),
				current: {
					tracks: sequence.tracks,
					markers: sequence.markers,
					background: project.settings.background,
					cues,
				},
			})
		: undefined;
	const issues = applyDismissals({
		issues: collectIssues({
			sequence,
			projectItems: editor.media.getProjectItems(),
			horizontal,
			captions: project.captions,
			cues,
			checkpoint: approved,
			comparison,
		}),
		dismissals: projectApproval(project).dismissals,
	});
	return {
		sequence,
		checkpoint: approved,
		comparison,
		issues,
		unresolved: issues.filter(({ dismissed }) => !dismissed),
	};
}

/** Reviews the saved cut with the media that would play it today. */
export function approvedIssues({
	editor,
	checkpoint,
	sequence,
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
	sequence: TSequence;
}): ReviewIssue[] {
	return applyDismissals({
		issues: collectIssues({
			sequence: {
				...sequence,
				tracks: checkpoint.tracks,
				markers: checkpoint.markers,
			},
			projectItems: editor.media.getProjectItems(),
			horizontal: true,
			captions: checkpoint.captions,
			cues: checkpoint.cues,
			checkpoint,
		}),
		dismissals: projectApproval(editor.project.getActive()).dismissals,
	});
}
