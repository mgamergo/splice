import {
	type ExportRecord,
	type ExportSource,
	exportRecordSchema,
	type ProjectCaptions,
	type Replacement,
} from "@splice/bridge/delivery";
import { PROJECT_FORMATS } from "@splice/bridge";
import type { FrameRate } from "opencut-wasm";
import { z } from "zod";
import { callSplice, uploadExportFile } from "@/bridge/splice-api";
import { buildCaptionCues, cuesToSrt } from "@/captions/cues";
import { sequenceEndSeconds } from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import type { ExportScene } from "@/core/managers/renderer-manager";
import type { TCanvasSize } from "@/project/types";
import { generateUUID } from "@/utils/id";
import type { DeliveryStep } from "./index";

/** Horizontal delivery is 1080p30 whatever the project's settings became. */
export const DELIVERY_FORMAT = {
	canvasSize: {
		width: PROJECT_FORMATS.horizontal.width,
		height: PROJECT_FORMATS.horizontal.height,
	},
	fps: { numerator: PROJECT_FORMATS.horizontal.fps, denominator: 1 },
} satisfies { canvasSize: TCanvasSize; fps: FrameRate };

/**
 * What a Horizontal export delivers, fixed when the creator asks for it:
 * everything the MP4 renders and the SRT timed against the same tracks.
 * Retrying renders and publishes this, never the edit as it is by then.
 */
export interface DeliverySnapshot {
	/** Names this Export click, so a retry can't publish a second pair. */
	deliveryId: string;
	scene: ExportScene;
	fps: FrameRate;
	srt: string;
	source: Omit<ExportSource, "fingerprint">;
}

export interface DeliveryInput extends Omit<DeliverySnapshot, "srt" | "source"> {
	captions: ProjectCaptions | undefined;
	source: Omit<DeliverySnapshot["source"], "cueCount">;
}

/** Captures the approved edit before an export waits for anything. */
export function captureDelivery({
	editor,
}: {
	editor: EditorCore;
}): DeliveryInput {
	const project = editor.project.getActive();
	const sequence = editor.sequences.getActiveSequence();
	const loudness = sequence.mix?.loudness;
	return {
		deliveryId: generateUUID(),
		scene: {
			tracks: sequence.tracks,
			projectItems: [...editor.media.getProjectItems()],
			canvasSize: DELIVERY_FORMAT.canvasSize,
			background: project.settings.background,
			...(loudness && {
				master: { gainDb: loudness.gainDb, ceilingDbtp: loudness.ceilingDbtp },
			}),
		},
		fps: DELIVERY_FORMAT.fps,
		captions: project.captions,
		source: {
			projectId: project.metadata.id,
			projectName: project.metadata.name,
			sequenceId: sequence.id,
			sequenceName: sequence.name,
			revision: editor.command.getRevision(),
			durationSeconds: sequenceEndSeconds({ sequence }),
		},
	};
}

function snapshotWithSpellings({
	input,
	spellings,
}: {
	input: DeliveryInput;
	spellings: Replacement[];
}): DeliverySnapshot {
	const { scene, fps, deliveryId, source, captions } = input;
	const cues = buildCaptionCues({
		tracks: scene.tracks,
		captions,
		spellings,
		sequenceEnd: source.durationSeconds,
		sequenceId: source.sequenceId,
	}).filter(({ text }) => text);
	return {
		deliveryId,
		scene,
		fps,
		srt: cuesToSrt(cues),
		source: { ...source, cueCount: cues.length },
	};
}

export function takeDeliverySnapshot({
	editor,
}: {
	editor: EditorCore;
}): DeliverySnapshot {
	return snapshotWithSpellings({
		input: captureDelivery({ editor }),
		spellings: useCaptionsStore.getState().spellings,
	});
}

/** Applies the saved spellings to the cues of the approved edit. */
export async function prepareDelivery({
	input,
}: {
	input: DeliveryInput;
}): Promise<DeliverySnapshot> {
	const spellings = await useCaptionsStore.getState().loadSpellings();
	return snapshotWithSpellings({ input, spellings });
}

/** The files the tracks play, by what identifies them on disk. */
function usedMedia({ tracks, projectItems }: ExportScene) {
	const used = new Set(
		[tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
			track.clips.flatMap((clip) => ("mediaId" in clip ? [clip.mediaId] : [])),
		),
	);
	return projectItems
		.filter(({ id }) => used.has(id))
		.map(({ id, type, file }) => ({
			id,
			type,
			name: file.name,
			size: file.size,
			lastModified: file.lastModified,
			...("kind" in file && { path: file.path }),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Identifies an edit across reloads, unlike the revision counter: a hash of
 * everything the export renders (tracks, media, frame, background and fps)
 * and the SRT. Decoded audio buffers are left out.
 */
export async function deliveryFingerprint({
	scene,
	fps,
	srt,
}: Pick<DeliverySnapshot, "scene" | "fps" | "srt">): Promise<string> {
	/* eslint-disable opencut/prefer-object-params -- JSON.stringify calls replacers with (key, value). */
	const withoutBuffers = (key: string, value: unknown) =>
		key === "buffer" ? undefined : value;
	/* eslint-enable opencut/prefer-object-params */
	const render = {
		canvasSize: scene.canvasSize,
		background: scene.background,
		fps,
		media: usedMedia(scene),
		master: scene.master,
	};
	const text = `${JSON.stringify(scene.tracks, withoutBuffers)}\n${JSON.stringify(render)}\n${srt}`;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export class DeliveryError extends Error {
	readonly step: DeliveryStep;

	constructor({ step, message }: { step: DeliveryStep; message: string }) {
		super(message);
		this.step = step;
	}
}

const beginResultSchema = z.union([
	z.object({ exportId: z.string() }),
	// This Export click already published its pair; an answer was lost.
	z.object({ committed: exportRecordSchema }),
]);

/**
 * Writes the MP4 and SRT into `splice`'s staging folder, then publishes both
 * under Exports at once. A failed step names itself, and `splice` drops the
 * staged files, so earlier pairs stay as they were.
 */
export async function publishDelivery({
	snapshot,
	video,
	signal,
	onStep,
}: {
	snapshot: DeliverySnapshot;
	video: ArrayBuffer;
	signal: AbortSignal;
	onStep: (step: DeliveryStep) => void;
}): Promise<ExportRecord> {
	async function step<T>({
		name,
		run,
	}: {
		name: DeliveryStep;
		run: () => Promise<T>;
	}) {
		onStep(name);
		try {
			return await run();
		} catch (error) {
			if (signal.aborted) throw error;
			throw new DeliveryError({
				step: name,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const source: ExportSource = {
		...snapshot.source,
		fingerprint: await deliveryFingerprint(snapshot),
	};
	const begun = await step({
		name: "upload-video",
		run: async () =>
			beginResultSchema.parse(
				await callSplice({
					method: "exports.begin",
					params: { ...source, deliveryId: snapshot.deliveryId },
				}),
			),
	});
	if ("committed" in begun) return begun.committed;
	const { exportId } = begun;
	try {
		await step({
			name: "upload-video",
			run: () =>
				uploadExportFile({
					exportId,
					kind: "mp4",
					body: new Blob([video], { type: "video/mp4" }),
					signal,
				}),
		});
		await step({
			name: "upload-captions",
			run: () =>
				uploadExportFile({
					exportId,
					kind: "srt",
					body: new Blob([snapshot.srt], { type: "application/x-subrip" }),
					signal,
				}),
		});
		return await step({
			name: "publish",
			run: async () =>
				exportRecordSchema.parse(
					await callSplice({
						method: "exports.publish",
						params: { exportId },
					}),
				),
		});
	} catch (error) {
		void callSplice({ method: "exports.abort", params: { exportId } }).catch(
			() => {},
		);
		throw error;
	}
}

/** One published pair, as the export history lists it. */
export const listedExportSchema = exportRecordSchema.extend({
	files: z.object({ mp4: z.string(), srt: z.string() }),
	present: z.boolean(),
});
export type ListedExport = z.infer<typeof listedExportSchema>;

export async function listExports({
	projectId,
}: {
	projectId: string;
}): Promise<{ folder: string; exports: ListedExport[] }> {
	return z
		.object({ folder: z.string(), exports: z.array(listedExportSchema) })
		.parse(await callSplice({ method: "exports.list", params: { projectId } }));
}

export async function openExportsFolder(): Promise<{
	opened: boolean;
	folder: string;
	error?: string;
}> {
	return z
		.object({
			opened: z.boolean(),
			folder: z.string(),
			error: z.string().optional(),
		})
		.parse(await callSplice({ method: "exports.open" }));
}
