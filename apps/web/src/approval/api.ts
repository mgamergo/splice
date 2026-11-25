import {
	type CheckpointSummary,
	checkpointRequestSchema,
	dismissIssueRequestSchema,
	finalizeCutRequestSchema,
	issuesListRequestSchema,
} from "@splice/bridge/approval";
import type { EditorApi } from "@/agent/editor-api";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import { deliveryFingerprint, takeDeliverySnapshot } from "@/export/deliver";
import { projectFormat } from "@/project/format";
import {
	captureApproval,
	commitApproval,
	dismissIssue,
	projectApproval,
} from "./checkpoint";
import { describeChanges } from "./compare";
import { reviewState } from "./review";
import type { ApprovedCheckpoint } from "./types";

function summarize(checkpoint: ApprovedCheckpoint): CheckpointSummary {
	const {
		tracks: _tracks,
		shortFrame: _shortFrame,
		markers: _markers,
		background: _background,
		sequenceCaptions: _sequenceCaptions,
		captions: _captions,
		srt: _srt,
		cues: _cues,
		footage: _footage,
		...summary
	} = checkpoint;
	return summary;
}

const round = (seconds: number) => Math.round(seconds * 100) / 100;

/**
 * The agent's view of approval: finalize the cut, compare with the approved
 * checkpoint and work through review issues. Export stays the creator's.
 */
export class ApprovalApi {
	private readonly editor: EditorCore;
	private readonly api: EditorApi;

	constructor({ editor, api }: { editor: EditorCore; api: EditorApi }) {
		this.editor = editor;
		this.api = api;
	}

	private error({
		code,
		message,
	}: {
		code: "INVALID_REQUEST" | "INVALID_OP" | "NO_PROJECT";
		message: string;
	}) {
		return {
			ok: false as const,
			code,
			message,
			revision: this.api.getRevision(),
		};
	}

	private noProject() {
		return !this.editor.project.getActiveOrNull() ||
			!this.editor.sequences.getActiveSequenceOrNull()
			? this.error({ code: "NO_PROJECT", message: "No project is open" })
			: undefined;
	}

	private async loadSpellings() {
		const project = this.editor.project.getActiveOrNull();
		if (project && projectFormat({ project }) === "horizontal")
			await useCaptionsStore.getState().loadSpellings();
	}

	/** Saves the active sequence's current edit as the approved checkpoint. */
	async finalizeCut(request: unknown) {
		const parsed = finalizeCutRequestSchema.safeParse(request);
		if (!parsed.success)
			return this.error({
				code: "INVALID_REQUEST",
				message: parsed.error.message,
			});
		// Spellings shape the SRT; load them before checking what the agent saw.
		await this.loadSpellings();
		const conflict = this.api.checkWrite(parsed.data);
		if (conflict) return conflict;
		const capture = captureApproval({
			editor: this.editor,
			origin: "agent",
			note: parsed.data.note,
		});
		try {
			const { checkpoint, saved } = await commitApproval({
				editor: this.editor,
				capture,
			});
			const { unresolved } = reviewState({ editor: this.editor });
			return {
				ok: true as const,
				revision: this.api.getRevision(),
				saved,
				checkpoint: summarize(checkpoint),
				...(!saved && {
					hint: "This edit was already the approved checkpoint, so nothing new was saved.",
				}),
				unresolvedIssues: unresolved.length,
			};
		} catch (failure) {
			return this.error({
				code: "INVALID_OP",
				message: failure instanceof Error ? failure.message : String(failure),
			});
		}
	}

	/** The current edit, its last approved checkpoint and how they differ. */
	async checkpointStatus() {
		await this.loadSpellings();
		const missing = this.noProject();
		if (missing) return missing;
		const project = this.editor.project.getActive();
		const sequence = this.editor.sequences.getActiveSequence();
		const snapshot = takeDeliverySnapshot({ editor: this.editor });
		const { checkpoint, comparison, unresolved, issues } = reviewState({
			editor: this.editor,
		});
		const currentFingerprint = await deliveryFingerprint(snapshot);
		const legacyMatch =
			checkpoint &&
			checkpoint.fingerprint !== currentFingerprint &&
			checkpoint.footage.every(({ contentHash }) => !contentHash) &&
			checkpoint.fingerprint ===
				(await deliveryFingerprint({ ...snapshot, legacyMedia: true }));
		return {
			ok: true as const,
			projectId: project.metadata.id,
			sequenceId: sequence.id,
			sequenceName: sequence.name,
			revision: snapshot.source.revision,
			currentFingerprint,
			checkpoint: checkpoint ? summarize(checkpoint) : null,
			matchesApproved: checkpoint
				? !!comparison?.identical &&
					(checkpoint.fingerprint === currentFingerprint || legacyMatch) &&
					!issues.some(
						({ kind }) =>
							kind === "changed-footage" || kind === "missing-footage",
					)
				: false,
			changedPassages: comparison?.passages.length ?? 0,
			changes: comparison ? describeChanges(comparison.changes) : "",
			unresolvedIssues: unresolved.length,
			dismissedIssues: issues.length - unresolved.length,
			/** Every checkpoint of the project, oldest first. */
			checkpoints: projectApproval(project).checkpoints.map(summarize),
		};
	}

	/** The passages that changed since the approved checkpoint. */
	async checkpointCompare(request: unknown) {
		const parsed = checkpointRequestSchema.safeParse(request ?? {});
		if (!parsed.success)
			return this.error({
				code: "INVALID_REQUEST",
				message: parsed.error.message,
			});
		await this.loadSpellings();
		const missing = this.noProject();
		if (missing) return missing;
		const project = this.editor.project.getActive();
		const sequence = this.editor.sequences.getActiveSequence();
		const { checkpointId } = parsed.data;
		const chosen = checkpointId
			? projectApproval(project).checkpoints.find(
					({ id }) => id === checkpointId,
				)
			: undefined;
		if (checkpointId && !chosen)
			return this.error({
				code: "INVALID_OP",
				message: `No checkpoint ${checkpointId}. Read checkpoint_status for the ids.`,
			});
		if (chosen && chosen.sequenceId !== sequence.id)
			return this.error({
				code: "INVALID_OP",
				message: `Checkpoint ${chosen.id} belongs to sequence ${chosen.sequenceName}; open it to compare.`,
			});
		const { checkpoint, comparison } = reviewState({
			editor: this.editor,
			checkpoint: chosen,
		});
		if (!checkpoint || !comparison)
			return this.error({
				code: "INVALID_OP",
				message:
					"This sequence has no approved checkpoint yet. The creator finalizes the cut first.",
			});
		return {
			ok: true as const,
			sequenceId: sequence.id,
			revision: this.api.getRevision(),
			checkpoint: summarize(checkpoint),
			identical: comparison.identical,
			passages: comparison.passages.map((passage) => ({
				start: round(passage.start),
				end: round(passage.end),
				approvedStart: round(passage.approvedStart),
				approvedEnd: round(passage.approvedEnd),
				summary: describeChanges(passage.changes),
				changes: passage.changes.map((change) => ({
					...change,
					start: round(change.start),
					end: round(change.end),
					approvedStart: round(change.approvedStart),
					approvedEnd: round(change.approvedEnd),
				})),
			})),
		};
	}

	async issuesList(request: unknown) {
		const parsed = issuesListRequestSchema.safeParse(request ?? {});
		if (!parsed.success)
			return this.error({
				code: "INVALID_REQUEST",
				message: parsed.error.message,
			});
		await this.loadSpellings();
		const missing = this.noProject();
		if (missing) return missing;
		const { issues, unresolved } = reviewState({ editor: this.editor });
		return {
			ok: true as const,
			revision: this.api.getRevision(),
			issues: (parsed.data.includeDismissed ? issues : unresolved).map(
				(issue) => ({
					...issue,
					start: round(issue.start),
					end: round(issue.end),
				}),
			),
			unresolved: unresolved.length,
			dismissed: issues.length - unresolved.length,
		};
	}

	/** Dismisses one issue until its evidence changes. */
	async dismissIssue(request: unknown) {
		const parsed = dismissIssueRequestSchema.safeParse(request);
		if (!parsed.success)
			return this.error({
				code: "INVALID_REQUEST",
				message: parsed.error.message,
			});
		await this.loadSpellings();
		const missing = this.noProject();
		if (missing) return missing;
		const { issueId, evidence, reason } = parsed.data;
		const issue = reviewState({ editor: this.editor }).issues.find(
			({ id }) => id === issueId,
		);
		if (!issue)
			return this.error({
				code: "INVALID_OP",
				message: `No issue ${issueId} on this sequence. Read issues_list again.`,
			});
		if (issue.evidence !== evidence)
			return this.error({
				code: "INVALID_OP",
				message:
					"The issue changed since it was listed. Read issues_list again.",
			});
		const dismissal = dismissIssue({
			editor: this.editor,
			issueId,
			evidence,
			by: "agent",
			reason,
		});
		return { ok: true as const, revision: this.api.getRevision(), dismissal };
	}
}
