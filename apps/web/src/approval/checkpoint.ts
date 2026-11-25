import {
	type CheckpointOrigin,
	checkpointSummarySchema,
	type Dismissal,
	type DismissedBy,
	dismissalSchema,
} from "@splice/bridge/approval";
import { projectCaptionsSchema } from "@splice/bridge/delivery";
import { captionsRequestSchema } from "@splice/bridge/ops";
import { z } from "zod";
import { sequenceCaptionCues } from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import {
	type DeliverySnapshot,
	deliveryFingerprint,
	takeDeliverySnapshot,
} from "@/export/deliver";
import { projectFormat } from "@/project/format";
import type { TProject } from "@/project/types";
import type { Marker, SequenceTracks, TSequence } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import type { ComparableEdit } from "./compare";
import type {
	ApprovedCheckpoint,
	FootageIdentity,
	ProjectApproval,
} from "./types";

const EMPTY_APPROVAL: ProjectApproval = { checkpoints: [], dismissals: [] };
/** Dismissals of issues long gone are dropped past this many. */
const MAX_DISMISSALS = 500;

/** Copies tracks without decoded audio buffers, which neither save nor compare. */
function withoutBuffers(tracks: SequenceTracks): SequenceTracks {
	return JSON.parse(
		JSON.stringify(tracks, (key, value: unknown) =>
			key === "buffer" ? undefined : value,
		),
	);
}

/** The recordings the sequence uses, as they are on disk now. */
export function footageIdentities({
	editor,
	tracks,
}: {
	editor: EditorCore;
	tracks: SequenceTracks;
}): FootageIdentity[] {
	const used = new Set(
		[tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
			track.clips.flatMap((clip) => ("mediaId" in clip ? [clip.mediaId] : [])),
		),
	);
	return editor.media
		.getProjectItems()
		.filter(({ id, ephemeral }) => used.has(id) && !ephemeral)
		.map(({ id, name, file }) => ({
			projectItemId: id,
			name,
			size: file.size,
			lastModified: file.lastModified,
		}));
}

/**
 * The active sequence's current edit as a checkpoint, with the same
 * fingerprint an export of it would record. Saved spellings shape the SRT, so
 * they load first.
 */
export async function takeCheckpoint({
	editor,
	origin,
	note,
}: {
	editor: EditorCore;
	origin: CheckpointOrigin;
	note?: string;
}): Promise<ApprovedCheckpoint> {
	const project = editor.project.getActive();
	if (projectFormat({ project }) === "horizontal")
		await useCaptionsStore.getState().loadSpellings();
	const sequence = editor.sequences.getActiveSequence();
	const snapshot = takeDeliverySnapshot({ editor });
	const tracks = withoutBuffers(snapshot.tracks);
	return {
		id: generateUUID(),
		sequenceId: sequence.id,
		sequenceName: sequence.name,
		approvedAt: new Date().toISOString(),
		revision: snapshot.source.revision,
		fingerprint: await deliveryFingerprint(snapshot),
		durationSeconds: snapshot.source.durationSeconds,
		cueCount: snapshot.source.cueCount,
		origin,
		...(note && { note }),
		tracks,
		markers: structuredClone(sequence.markers),
		...(sequence.captions && {
			sequenceCaptions: structuredClone(sequence.captions),
		}),
		...(project.captions && { captions: structuredClone(project.captions) }),
		srt: snapshot.srt,
		cues: sequenceCaptionCues({ editor, sequence })
			.filter(({ text }) => text)
			.map(({ start, end, text }) => ({ start, end, text })),
		footage: footageIdentities({ editor, tracks }),
	};
}

export function projectApproval(project: TProject | null): ProjectApproval {
	return project?.approval ?? EMPTY_APPROVAL;
}

/** The last checkpoint approved for a sequence, if any. */
export function latestCheckpoint({
	project,
	sequenceId,
}: {
	project: TProject | null;
	sequenceId: string;
}): ApprovedCheckpoint | undefined {
	return projectApproval(project).checkpoints.findLast(
		(checkpoint) => checkpoint.sequenceId === sequenceId,
	);
}

/** Saved with the project, outside the undo history: undoing an edit never unapproves one. */
function updateApproval({
	editor,
	update,
}: {
	editor: EditorCore;
	update: (approval: ProjectApproval) => ProjectApproval;
}): void {
	const project = editor.project.getActive();
	editor.project.setActiveProject({
		project: { ...project, approval: update(projectApproval(project)) },
	});
	editor.save.markDirty();
}

/**
 * Saves a checkpoint as the sequence's approved one. Approving the edit the
 * last checkpoint already holds keeps that checkpoint and returns it.
 */
export function saveCheckpoint({
	editor,
	checkpoint,
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
}): { checkpoint: ApprovedCheckpoint; saved: boolean } {
	const latest = latestCheckpoint({
		project: editor.project.getActive(),
		sequenceId: checkpoint.sequenceId,
	});
	if (latest?.fingerprint === checkpoint.fingerprint)
		return { checkpoint: latest, saved: false };
	updateApproval({
		editor,
		update: (approval) => ({
			...approval,
			checkpoints: [...approval.checkpoints, checkpoint],
		}),
	});
	return { checkpoint, saved: true };
}

/** Takes and saves the active sequence's current edit as approved. */
export async function finalizeCut({
	editor,
	origin,
	note,
}: {
	editor: EditorCore;
	origin: CheckpointOrigin;
	note?: string;
}) {
	return saveCheckpoint({
		editor,
		checkpoint: await takeCheckpoint({ editor, origin, note }),
	});
}

/** Keeps an issue dismissed until its evidence changes. */
export function dismissIssue({
	editor,
	issueId,
	evidence,
	by,
	reason,
}: {
	editor: EditorCore;
	issueId: string;
	evidence: string;
	by: DismissedBy;
	reason?: string;
}): Dismissal {
	const dismissal: Dismissal = {
		issueId,
		evidence,
		at: new Date().toISOString(),
		by,
		...(reason && { reason }),
	};
	updateApproval({
		editor,
		update: (approval) => ({
			...approval,
			dismissals: [
				...approval.dismissals.filter((entry) => entry.issueId !== issueId),
				dismissal,
			].slice(-MAX_DISMISSALS),
		}),
	});
	return dismissal;
}

export function undismissIssue({
	editor,
	issueId,
}: {
	editor: EditorCore;
	issueId: string;
}): void {
	updateApproval({
		editor,
		update: (approval) => ({
			...approval,
			dismissals: approval.dismissals.filter(
				(entry) => entry.issueId !== issueId,
			),
		}),
	});
}

/** The parts of a checkpoint a comparison reads. */
export function approvedEdit(checkpoint: ApprovedCheckpoint): ComparableEdit {
	return {
		tracks: checkpoint.tracks,
		markers: checkpoint.markers,
		cues: checkpoint.cues,
	};
}

/** The parts of a sequence a comparison reads, with its current SRT cues. */
export function currentEdit({
	editor,
	sequence,
}: {
	editor: EditorCore;
	sequence: TSequence;
}): ComparableEdit {
	const project = editor.project.getActiveOrNull();
	const horizontal = !!project && projectFormat({ project }) === "horizontal";
	return {
		tracks: sequence.tracks,
		markers: sequence.markers,
		cues: horizontal
			? sequenceCaptionCues({ editor, sequence })
					.filter(({ text }) => text)
					.map(({ start, end, text }) => ({ start, end, text }))
			: [],
	};
}

/**
 * What an export of the checkpoint delivers: its tracks and SRT, with every
 * other render input taken as an export of the current edit would.
 */
export function checkpointDeliverySnapshot({
	editor,
	checkpoint,
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
}): DeliverySnapshot {
	const current = takeDeliverySnapshot({ editor });
	return {
		...current,
		tracks: checkpoint.tracks,
		srt: checkpoint.srt,
		source: {
			...current.source,
			sequenceId: checkpoint.sequenceId,
			sequenceName: checkpoint.sequenceName,
			revision: checkpoint.revision,
			durationSeconds: checkpoint.durationSeconds,
			cueCount: checkpoint.cueCount,
		},
	};
}

const isTracks = (value: unknown): value is SequenceTracks =>
	typeof value === "object" &&
	value !== null &&
	"main" in value &&
	"overlay" in value &&
	Array.isArray(value.overlay) &&
	"audio" in value &&
	Array.isArray(value.audio);

const storedCheckpointSchema = checkpointSummarySchema.extend({
	tracks: z.custom<SequenceTracks>(isTracks),
	markers: z.array(z.unknown()),
	sequenceCaptions: captionsRequestSchema.optional(),
	captions: projectCaptionsSchema.optional(),
	srt: z.string(),
	cues: z.array(
		z.object({ start: z.number(), end: z.number(), text: z.string() }),
	),
	footage: z.array(
		z.object({
			projectItemId: z.string(),
			name: z.string(),
			size: z.number(),
			lastModified: z.number(),
		}),
	),
});

/**
 * Reads a saved project's approval. A checkpoint or dismissal that doesn't
 * parse is dropped on its own, so one bad entry never loses the rest.
 */
export function parseProjectApproval({
	raw,
	parseMarkers,
}: {
	raw: unknown;
	parseMarkers: (raw: unknown) => Marker[];
}): ProjectApproval | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { checkpoints, dismissals } = raw as Record<string, unknown>;
	return {
		checkpoints: (Array.isArray(checkpoints) ? checkpoints : []).flatMap(
			(entry) => {
				const parsed = storedCheckpointSchema.safeParse(entry);
				if (!parsed.success) return [];
				const { markers, ...rest } = parsed.data;
				return [{ ...rest, markers: parseMarkers(markers) }];
			},
		),
		dismissals: (Array.isArray(dismissals) ? dismissals : []).flatMap(
			(entry) => {
				const parsed = dismissalSchema.safeParse(entry);
				return parsed.success ? [parsed.data] : [];
			},
		),
	};
}
