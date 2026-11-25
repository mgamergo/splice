import { PROJECT_FORMATS } from "@splice/bridge";
import type { FrameRate } from "opencut-wasm";
import {
	type ExportRecord,
	type ExportSource,
	exportRecordSchema,
} from "@splice/bridge/delivery";
import { z } from "zod";
import { callSplice, uploadExportFile } from "@/bridge/splice-api";
import { cuesToSrt } from "@/captions/cues";
import {
	sequenceCaptionCues,
	sequenceEndSeconds,
} from "@/captions/project-captions";
import type { EditorCore } from "@/core";
import type { ExportScene } from "@/core/managers/renderer-manager";
import type { DeliveryStep } from "./index";

/**
 * What a Horizontal export delivers, fixed when the creator asks for it: the
 * sequence's tracks for the MP4 and the SRT timed against those same tracks.
 */
export interface DeliverySnapshot {
	scene: ExportScene;
	/** The live edit at the Export click, even when exporting a past checkpoint. */
	requestedRevision: number;
	fps: FrameRate;
	srt: string;
	source: Omit<ExportSource, "fingerprint">;
}

export function takeDeliverySnapshot({
	editor,
	cues: reviewedCues,
}: {
	editor: EditorCore;
	cues?: ReturnType<typeof sequenceCaptionCues>;
}): DeliverySnapshot {
	const project = editor.project.getActive();
	const sequence = editor.sequences.getActiveSequence();
	const cues = (reviewedCues ?? sequenceCaptionCues({ editor, sequence })).filter(
		({ text }) => text,
	);
	const { width, height, fps } = PROJECT_FORMATS.horizontal;
	const revision = editor.command.getRevision();
	return {
		requestedRevision: revision,
		scene: {
			tracks: sequence.tracks,
			projectItems: [...editor.media.getProjectItems()],
			canvasSize: { width, height },
			background: project.settings.background,
		},
		fps: { numerator: fps, denominator: 1 },
		srt: cuesToSrt(cues),
		source: {
			projectId: project.metadata.id,
			projectName: project.metadata.name,
			sequenceId: sequence.id,
			sequenceName: sequence.name,
			revision,
			durationSeconds: sequenceEndSeconds({ sequence }),
			cueCount: cues.length,
		},
	};
}

/**
 * Identifies an edit across reloads, unlike the revision counter: a hash of
 * the exported tracks and SRT. Decoded audio buffers are left out.
 */
export async function deliveryFingerprint({
	scene: { tracks },
	srt,
}: Pick<DeliverySnapshot, "scene" | "srt">): Promise<string> {
	/* eslint-disable opencut/prefer-object-params -- JSON.stringify calls replacers with (key, value). */
	const withoutBuffers = (key: string, value: unknown) =>
		key === "buffer" ? undefined : value;
	/* eslint-enable opencut/prefer-object-params */
	const text = `${JSON.stringify(tracks, withoutBuffers)}\n${srt}`;
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

const beginResultSchema = z.object({ exportId: z.string() });

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
	const { exportId } = await step({
		name: "upload-video",
		run: async () =>
			beginResultSchema.parse(
				await callSplice({ method: "exports.begin", params: source }),
			),
	});
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
