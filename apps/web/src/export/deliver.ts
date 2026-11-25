import {
	type ExportRecord,
	type ExportSource,
	exportRecordSchema,
} from "@splice/bridge/delivery";
import type { SequenceMix } from "@splice/bridge/mix";
import { z } from "zod";
import { callSplice, uploadExportFile } from "@/bridge/splice-api";
import { cuesToSrt } from "@/captions/cues";
import {
	sequenceCaptionCues,
	sequenceEndSeconds,
} from "@/captions/project-captions";
import type { EditorCore } from "@/core";
import type { SequenceTracks } from "@/timeline/types";
import type { DeliveryStep } from "./index";

/**
 * What a Horizontal export delivers, fixed when the creator asks for it: the
 * sequence's tracks for the MP4 and the SRT timed against those same tracks.
 */
export interface DeliverySnapshot {
	tracks: SequenceTracks;
	/** The final mix: music settings and the whole-mix gain export applies. */
	mix?: SequenceMix;
	srt: string;
	source: Omit<ExportSource, "fingerprint">;
}

export function takeDeliverySnapshot({
	editor,
}: {
	editor: EditorCore;
}): DeliverySnapshot {
	const project = editor.project.getActive();
	const sequence = editor.sequences.getActiveSequence();
	const cues = sequenceCaptionCues({ editor, sequence }).filter(
		({ text }) => text,
	);
	return {
		tracks: sequence.tracks,
		...(sequence.mix && { mix: sequence.mix }),
		srt: cuesToSrt(cues),
		source: {
			projectId: project.metadata.id,
			projectName: project.metadata.name,
			sequenceId: sequence.id,
			sequenceName: sequence.name,
			revision: editor.command.getRevision(),
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
	tracks,
	mix,
	srt,
}: Pick<DeliverySnapshot, "tracks" | "mix" | "srt">): Promise<string> {
	/* eslint-disable opencut/prefer-object-params -- JSON.stringify calls replacers with (key, value). */
	const withoutBuffers = (key: string, value: unknown) =>
		key === "buffer" ? undefined : value;
	/* eslint-enable opencut/prefer-object-params */
	// The mix gain changes the MP4's audio; a mix never set keeps old fingerprints.
	const gain = mix?.loudness
		? `\n${JSON.stringify([mix.loudness.gainDb, mix.loudness.ceilingDbtp])}`
		: "";
	const text = `${JSON.stringify(tracks, withoutBuffers)}\n${srt}${gain}`;
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
