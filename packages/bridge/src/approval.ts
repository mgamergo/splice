/**
 * Approval: the checkpoint "Finalize cut" saves, what changed since it, and
 * the review issues the creator fixes or dismisses before exporting.
 */
import { z } from "zod";
import { expectedRevision, shortStyleSchema } from "./ops";

/** Who saved a checkpoint: the creator in Splice, the agent, or an export. */
export const CHECKPOINT_ORIGINS = ["editor", "agent", "export"] as const;
export type CheckpointOrigin = (typeof CHECKPOINT_ORIGINS)[number];

/** What identifies an approved checkpoint, without the edit it holds. */
export const checkpointSummarySchema = z.strictObject({
	id: z.string().min(1).max(200),
	sequenceId: z.string().min(1).max(200),
	sequenceName: z.string().max(200),
	approvedAt: z.string(),
	/** The editor's command revision when it was saved; it restarts on reload. */
	revision: z.number().int().nonnegative(),
	/** The same hash an export of this edit records, stable across reloads. */
	fingerprint: z.string().regex(/^[0-9a-f]{8,64}$/),
	durationSeconds: z.number().nonnegative(),
	cueCount: z.number().int().nonnegative(),
	origin: z.enum(CHECKPOINT_ORIGINS),
	note: z.string().max(500).optional(),
	shortStyle: shortStyleSchema.optional(),
});
export type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;

export const ISSUE_KINDS = [
	"changed-since-approval",
	"missing-footage",
	"changed-footage",
	"no-captions",
	"uncaptioned-recording",
	"caption-empty",
	"caption-overlong",
	"caption-fast",
	"marker-conflict",
	"flagged",
	"graphic-flag",
	"short-hook-flag",
	"stale-mix",
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** One thing to fix or dismiss before export. Times are sequence seconds. */
export interface ReviewIssue {
	/** Stable while the issue lasts, so a dismissal can name it. */
	id: string;
	kind: IssueKind;
	title: string;
	detail: string;
	start: number;
	end: number;
	/** The linked graphic, which may be off the timeline. */
	graphicId?: string;
	/** A hash of what raised the issue; a dismissal holds only while it matches. */
	evidence: string;
	dismissed?: { at: string; by: DismissedBy; reason?: string };
}

export const DISMISSED_BY = ["creator", "agent"] as const;
export type DismissedBy = (typeof DISMISSED_BY)[number];

export const dismissalSchema = z.strictObject({
	issueId: z.string().min(1).max(500),
	evidence: z.string().min(1).max(200),
	at: z.string(),
	by: z.enum(DISMISSED_BY),
	reason: z.string().max(500).optional(),
});
export type Dismissal = z.infer<typeof dismissalSchema>;

export const finalizeCutRequestSchema = z.strictObject({
	expectedRevision,
	note: z
		.string()
		.trim()
		.max(500)
		.optional()
		.describe("What the creator approved, in their words. Optional."),
});

export const checkpointRequestSchema = z.strictObject({
	checkpointId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Compare with this checkpoint. Defaults to the active sequence's last approved one.",
		),
});

export const issuesListRequestSchema = z.strictObject({
	includeDismissed: z
		.boolean()
		.default(false)
		.describe("Also list issues dismissed while their evidence still matches."),
});

export const dismissIssueRequestSchema = z.strictObject({
	issueId: z
		.string()
		.min(1)
		.max(500)
		.describe("The issue's id from issues_list"),
	evidence: z
		.string()
		.min(1)
		.max(200)
		.describe(
			"The issue's evidence from issues_list. The dismissal lapses when it changes.",
		),
	reason: z.string().trim().max(500).optional(),
});

/** One change between the approved checkpoint and the current edit. */
export interface CheckpointChange {
	kind: "added" | "removed" | "changed" | "gap";
	what: "clip" | "marker" | "caption" | "background" | "mix" | "Short style";
	evidence: string;
	/** The track, marker or caption it concerns, for people to read. */
	label: string;
	/** On the current edit. */
	start: number;
	end: number;
	/** On the approved edit. */
	approvedStart: number;
	approvedEnd: number;
}

/** Changes that lie together, to play and compare as one passage. */
export interface ChangedPassage {
	start: number;
	end: number;
	approvedStart: number;
	approvedEnd: number;
	changes: CheckpointChange[];
}
