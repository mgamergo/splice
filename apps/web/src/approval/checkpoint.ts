import {
	type CheckpointOrigin,
	checkpointSummarySchema,
	type Dismissal,
	type DismissedBy,
	dismissalSchema,
} from "@splice/bridge/approval";
import { projectCaptionsSchema } from "@splice/bridge/delivery";
import { sequenceGraphicsSchema } from "@splice/bridge/graphics";
import { sequenceMixSchema } from "@splice/bridge/mix";
import { captionsRequestSchema } from "@splice/bridge/ops";
import { z } from "zod";
import { type CaptionCue } from "@/captions/cues";
import { sequenceCaptionCues } from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import {
	DELIVERY_FORMAT,
	type DeliverySnapshot,
	deliveryFingerprint,
	deliveryScene,
	takeDeliverySnapshot,
} from "@/export/deliver";
import { projectFormat } from "@/project/format";
import type { TProject } from "@/project/types";
import type { Marker, SequenceTracks, TSequence } from "@/timeline/types";
import { isDiskMedia } from "@/media/media-data";
import { referencedMedia, verifySequenceMedia } from "@/media/sequence-media";
import { generateUUID } from "@/utils/id";
import { stableStringify } from "./compare";
import type {
	ApprovedCheckpoint,
	FootageIdentity,
	ProjectApproval,
} from "./types";

const EMPTY_APPROVAL: ProjectApproval = { checkpoints: [], dismissals: [] };

/** Copies tracks without decoded audio buffers, which neither save nor compare. */
function withoutBuffers(tracks: SequenceTracks): SequenceTracks {
	return JSON.parse(
		JSON.stringify(tracks, (key, value: unknown) =>
			key === "buffer" ? undefined : value,
		),
	);
}

/** The recordings the sequence uses, as they are on disk now. */
function footageIdentities({
	editor,
	tracks,
}: {
	editor: EditorCore;
	tracks: SequenceTracks;
}): FootageIdentity[] {
	const used = referencedMedia({ tracks });
	return editor.media
		.getProjectItems()
		.filter(({ id }) => used.has(id))
		.map(({ id, name, file, missing }) => ({
			projectItemId: id,
			name,
			size: file.size,
			lastModified: file.lastModified,
			missing: !!missing,
			...(isDiskMedia(file) && {
				path: file.path,
				contentHash: file.contentHash,
			}),
		}));
}

/** Captures everything at the approval click, before hashing or saving. */
export function captureApproval({
	editor,
	origin,
	note,
	cues,
}: {
	editor: EditorCore;
	origin: CheckpointOrigin;
	note?: string;
	cues?: CaptionCue[];
}) {
	const project = editor.project.getActive();
	const sequence = editor.sequences.getActiveSequence();
	const horizontal = projectFormat({ project }) === "horizontal";
	const reviewedCues = horizontal
		? (cues ?? sequenceCaptionCues({ editor, sequence }))
		: [];
	const snapshot = takeDeliverySnapshot({ editor, cues: reviewedCues });
	const tracks = withoutBuffers(sequence.tracks);
	const data = {
		id: generateUUID(),
		sequenceId: sequence.id,
		sequenceName: sequence.name,
		approvedAt: new Date().toISOString(),
		revision: snapshot.source.revision,
		durationSeconds: snapshot.source.durationSeconds,
		cueCount: snapshot.source.cueCount,
		origin,
		...(note && { note }),
		tracks,
		...(sequence.graphics && { graphics: structuredClone(sequence.graphics) }),
		...(sequence.mix && { mix: structuredClone(sequence.mix) }),
		markers: structuredClone(sequence.markers),
		background: structuredClone(snapshot.scene.background),
		...(sequence.captions && {
			sequenceCaptions: structuredClone(sequence.captions),
		}),
		...(project.captions && {
			captions: structuredClone({
				...project.captions,
				spellings:
					project.captions.spellings ?? useCaptionsStore.getState().spellings,
			}),
		}),
		srt: snapshot.srt,
		cues: reviewedCues.map(({ id, start, end, text, correctedBy }) => ({
			id,
			start,
			end,
			text,
			correctedBy,
		})),
		footage: footageIdentities({ editor, tracks }),
	};
	return {
		data,
		mediaGeneration: editor.media.getGeneration(),
		snapshot: {
			...snapshot,
			scene: {
				...snapshot.scene,
				tracks: withoutBuffers(snapshot.scene.tracks),
			},
		},
	};
}

function approvalContent({
	sequenceName,
	tracks,
	graphics,
	mix,
	markers,
	background,
	sequenceCaptions,
	captions,
	srt,
	footage,
}: Omit<ApprovedCheckpoint, "fingerprint">) {
	return stableStringify({
		sequenceName,
		tracks,
		graphics,
		mix,
		markers,
		background,
		sequenceCaptions,
		captions,
		srt,
		footage: footage
			.map(({ projectItemId, missing, contentHash, ...metadata }) => ({
				projectItemId,
				missing,
				...(contentHash ? { contentHash } : metadata),
			}))
			.sort((a, b) => a.projectItemId.localeCompare(b.projectItemId)),
	});
}

function assertApprovalContext({
	editor,
	projectId,
	mediaGeneration,
}: {
	editor: EditorCore;
	projectId: string;
	mediaGeneration: number;
}): void {
	if (
		editor.project.getActiveOrNull()?.metadata.id !== projectId ||
		editor.media.getGeneration() !== mediaGeneration
	)
		throw new Error("The project changed. Open Review and try again.");
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

/** Persists the captured approval and returns the render inputs from that click. */
export async function commitApproval({
	editor,
	capture,
}: {
	editor: EditorCore;
	capture: ReturnType<typeof captureApproval>;
}) {
	const { snapshot, data, mediaGeneration } = capture;
	if (data.origin === "export") await verifySequenceMedia(snapshot.scene);
	const fingerprint = await deliveryFingerprint(snapshot);
	const checkpoint = { ...data, fingerprint };
	const result = await editor.project.saveCheckpoint({
		projectId: snapshot.source.projectId,
		mediaGeneration,
		checkpoint,
		matches: (latest) =>
			latest.revision === checkpoint.revision &&
			approvalContent(latest) === approvalContent(checkpoint),
	});
	return {
		...result,
		snapshot: {
			...snapshot,
			source: { ...snapshot.source, checkpointId: result.checkpoint.id },
		},
	};
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
	const project = editor.project.getActive();
	const revision = editor.command.getRevision();
	const mediaGeneration = editor.media.getGeneration();
	if (
		projectFormat({ project }) === "horizontal" &&
		!useCaptionsStore.getState().spellingsLoaded
	)
		await useCaptionsStore.getState().loadSpellings();
	assertApprovalContext({
		editor,
		projectId: project.metadata.id,
		mediaGeneration,
	});
	if (
		revision !== editor.command.getRevision() ||
		editor.timeline.isPreviewActive()
	)
		throw new Error("The edit changed. Review the current edit and try again.");
	return commitApproval({
		editor,
		capture: captureApproval({ editor, origin, note }),
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
			],
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

/** The saved timeline inputs shared by preview, review and delivery. */
export function checkpointSequence(
	checkpoint: ApprovedCheckpoint,
): Pick<
	TSequence,
	"id" | "name" | "tracks" | "markers" | "captions" | "mix" | "graphics"
> {
	return {
		id: checkpoint.sequenceId,
		name: checkpoint.sequenceName,
		tracks: checkpoint.tracks,
		graphics: checkpoint.graphics,
		markers: checkpoint.markers,
		captions: checkpoint.sequenceCaptions,
		mix: checkpoint.mix,
	};
}

/** Captures a delivery of the saved cut, with its own mix and SRT. */
export function checkpointDeliverySnapshot({
	editor,
	checkpoint,
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
}): DeliverySnapshot {
	const project = editor.project.getActive();
	return {
		deliveryId: generateUUID(),
		requestedRevision: editor.command.getRevision(),
		scene: deliveryScene({
			sequence: checkpointSequence(checkpoint),
			projectItems: editor.media.getProjectItems(),
			projectSources: checkpoint.captions?.sources,
			background: checkpoint.background,
		}),
		fps: DELIVERY_FORMAT.fps,
		srt: checkpoint.srt,
		source: {
			projectId: project.metadata.id,
			projectName: project.metadata.name,
			checkpointId: checkpoint.id,
			sequenceId: checkpoint.sequenceId,
			sequenceName: checkpoint.sequenceName,
			revision: checkpoint.revision,
			durationSeconds: checkpoint.durationSeconds,
			cueCount: checkpoint.cueCount,
		},
	};
}

const isTrack = (value: unknown) =>
	typeof value === "object" &&
	value !== null &&
	"type" in value &&
	"clips" in value &&
	Array.isArray(value.clips) &&
	value.clips.every(
		(clip) =>
			clip &&
			typeof clip === "object" &&
			typeof clip.startTime === "number" &&
			typeof clip.duration === "number",
	);

const isTracks = (value: unknown): value is SequenceTracks =>
	typeof value === "object" &&
	value !== null &&
	"main" in value &&
	isTrack(value.main) &&
	"overlay" in value &&
	Array.isArray(value.overlay) &&
	value.overlay.every(isTrack) &&
	"audio" in value &&
	Array.isArray(value.audio) &&
	value.audio.every(isTrack);

const storedCheckpointSchema = checkpointSummarySchema.extend({
	tracks: z.custom<SequenceTracks>(isTracks),
	graphics: sequenceGraphicsSchema.optional(),
	mix: sequenceMixSchema.optional(),
	markers: z.array(z.unknown()),
	background: z.discriminatedUnion("type", [
		z.object({ type: z.literal("color"), color: z.string() }),
		z.object({ type: z.literal("blur"), blurIntensity: z.number() }),
	]),
	sequenceCaptions: captionsRequestSchema.optional(),
	captions: projectCaptionsSchema.optional(),
	srt: z.string(),
	cues: z.array(
		z.object({
			id: z.string(),
			start: z.number(),
			end: z.number(),
			text: z.string(),
			correctedBy: z.enum(["cue", "project", "spelling"]).optional(),
		}),
	),
	footage: z.array(
		z.object({
			projectItemId: z.string(),
			name: z.string(),
			size: z.number(),
			lastModified: z.number(),
			path: z.string().optional(),
			contentHash: z.string().optional(),
			missing: z.boolean(),
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
	const checkpoints = "checkpoints" in raw ? raw.checkpoints : undefined;
	const dismissals = "dismissals" in raw ? raw.dismissals : undefined;
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
