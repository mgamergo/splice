import type { ReviewIssue } from "@splice/bridge/approval";
import type { Replacement } from "@splice/bridge/delivery";
import type { CaptionCue } from "@/captions/cues";
import { sequenceCaptionCues } from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import { deliveryScene } from "@/export/deliver";
import type { EditorCore } from "@/core";
import { projectFormat, projectShortStyle } from "@/project/format";
import type { TSequence } from "@/timeline/types";
import {
	checkpointSequence,
	latestCheckpoint,
	projectApproval,
} from "./checkpoint";
import {
	type CheckpointComparison,
	compareEdits,
	describeChanges,
} from "./compare";
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

export function hasUnavailableExportMedia({
	issues,
	approved,
}: {
	issues: ReviewIssue[];
	approved: boolean;
}): boolean {
	return issues.some(
		({ kind }) =>
			kind === "missing-footage" || (approved && kind === "changed-footage"),
	);
}

/** The reopen summary includes media differences even when their issues were dismissed. */
export function sinceApprovalSummary({
	comparison,
	issues,
}: Pick<ReviewState, "comparison" | "issues">): string | null {
	if (!comparison) return null;
	const media = issues.filter(
		({ kind }) => kind === "missing-footage" || kind === "changed-footage",
	);
	if (comparison.identical && media.length === 0)
		return "No changes: the current edit is the approved cut.";
	return [
		...(!comparison.identical
			? [
					`${comparison.passages.length} passage(s) changed: ${describeChanges(comparison.changes)}.`,
				]
			: []),
		...media.map(({ detail }) => detail),
	].join(" ");
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
	const shortStyle = projectShortStyle({ project });
	const horizontal = !shortStyle;
	const approved =
		checkpoint ?? latestCheckpoint({ project, sequenceId: sequence.id });
	const cues = horizontal
		? (reviewedCues ?? sequenceCaptionCues({ editor, sequence, spellings }))
		: [];
	const projectItems = editor.media.getProjectItems();
	const comparison = approved
		? compareEdits({
				approved: {
					...deliveryScene({
						sequence: checkpointSequence(approved),
						projectItems,
						projectSources: approved.captions?.sources,
						background: approved.background,
					}),
					shortStyle: approved.shortStyle ?? shortStyle,
					shortCaptionPosition: shortStyle ? approved.sequenceCaptions?.style?.position : undefined,
					markers: approved.markers,
					cues: approved.cues,
				},
				current: {
					...deliveryScene({
						sequence,
						projectItems,
						projectSources: project.captions?.sources,
						background: project.settings.background,
					}),
					shortStyle,
					shortCaptionPosition: shortStyle ? sequence.captions?.style?.position : undefined,
					markers: sequence.markers,
					cues,
				},
			})
		: undefined;
	const issues = applyDismissals({
		issues: collectIssues({
			sequence,
			projectItems,
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
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
}): ReviewIssue[] {
	return applyDismissals({
		issues: collectIssues({
			sequence: checkpointSequence(checkpoint),
			projectItems: editor.media.getProjectItems(),
			horizontal: projectFormat({ project: editor.project.getActive() }) === "horizontal",
			captions: checkpoint.captions,
			cues: checkpoint.cues,
			checkpoint,
		}),
		dismissals: projectApproval(editor.project.getActive()).dismissals,
	});
}
