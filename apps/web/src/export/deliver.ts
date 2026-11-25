import {
	type ExportRecord,
	type ExportSource,
	exportRecordSchema,
	type ProjectCaptions,
	type Replacement,
} from "@splice/bridge/delivery";
import { PROJECT_FORMATS, type ShortStyle } from "@splice/bridge";
import type { FrameRate } from "opencut-wasm";
import { z } from "zod";
import { callSplice, uploadExportFile } from "@/bridge/splice-api";
import { buildCaptionCues, type CaptionCue, cuesToSrt } from "@/captions/cues";
import { sequenceEndSeconds } from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import type { ExportScene } from "@/core/managers/renderer-manager";
import { projectShortStyle } from "@/project/format";
import type { TBackground, TCanvasSize, TProjectSettings } from "@/project/types";
import {
	pinRenderMedia,
	recordingIdentity,
	referencedMedia,
} from "@/media/sequence-media";
import { isMixLoudnessStale } from "@/mix/final-mix";
import { tracksWithMusicDucking } from "@/mix/music";
import { generateUUID } from "@/utils/id";
import type { DeliveryStep } from "./index";
import { shortCaptionDelivery } from "./short-srt";

/** Horizontal delivery is 1080p30 whatever the project's settings became. */
export const DELIVERY_FORMAT = {
	canvasSize: {
		width: PROJECT_FORMATS.horizontal.width,
		height: PROJECT_FORMATS.horizontal.height,
	},
	fps: { numerator: PROJECT_FORMATS.horizontal.fps, denominator: 1 },
} satisfies { canvasSize: TCanvasSize; fps: FrameRate };

/**
 * What an export delivers, fixed when the creator asks for it:
 * everything the MP4 renders and the SRT timed against the same tracks.
 * Retrying renders and publishes this, never the edit as it is by then.
 */
export type ShortDeliveryFrame = Pick<TProjectSettings, "canvasSize" | "fps">;

export interface DeliverySnapshot {
	shortStyle?: ShortStyle;
	/** Undefined preserves paired delivery for existing callers. */
	includeSrt?: boolean;
	/** Names this Export click, so a retry can't publish a second pair. */
	deliveryId: string;
	/** The live edit at the Export click, even when exporting a past checkpoint. */
	requestedRevision?: number;
	scene: ExportScene;
	fps: FrameRate;
	srt: string;
	source: Omit<ExportSource, "fingerprint">;
}

export interface DeliveryInput extends Omit<
	DeliverySnapshot,
	"srt" | "source"
> {
	captions: ProjectCaptions | undefined;
	source: Omit<DeliverySnapshot["source"], "cueCount">;
}

/** Builds the render inputs from the selected edit and pins its media. */
export function deliveryScene({
	sequence,
	projectItems,
	projectSources,
	background,
	shortCanvas,
}: Parameters<typeof tracksWithMusicDucking>[0] & {
	background: TBackground;
	shortCanvas?: TCanvasSize;
}): ExportScene {
	const loudness = sequence.mix?.loudness;
	return {
		tracks: tracksWithMusicDucking({ sequence, projectItems, projectSources }),
		projectItems: pinRenderMedia({ projectItems }),
		canvasSize: shortCanvas ?? DELIVERY_FORMAT.canvasSize,
		...(shortCanvas && {
			outputSize: {
				width: PROJECT_FORMATS.short.width,
				height: PROJECT_FORMATS.short.height,
			},
		}),
		background,
		master: loudness && {
			gainDb: loudness.gainDb,
			ceilingDbtp: loudness.ceilingDbtp,
		},
	};
}

/** Captures the approved edit before an export waits for anything. */
export function captureDelivery({
	editor,
	approval,
}: {
	editor: EditorCore;
	approval?: { acceptStaleGain: boolean };
}): DeliveryInput {
	const project = editor.project.getActive();
	const sequence = editor.sequences.getActiveSequence();
	const projectItems = editor.media.getProjectItems();
	const projectSources = project.captions?.sources;
	const shortStyle = projectShortStyle({ project });
	if (
		approval &&
		!approval.acceptStaleGain &&
		isMixLoudnessStale({ sequence, projectItems, projectSources })
	)
		throw new Error(
			"The mix changed since it was measured. Remeasure it or export with the saved gain.",
		);
	return {
		deliveryId: generateUUID(),
		...(shortStyle && { shortStyle }),
		scene: deliveryScene({
			sequence,
			projectItems,
			projectSources,
			background: project.settings.background,
			shortCanvas: shortStyle ? project.settings.canvasSize : undefined,
		}),
		fps: shortStyle ? project.settings.fps : DELIVERY_FORMAT.fps,
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
	reviewedCues,
}: {
	input: DeliveryInput;
	spellings: Replacement[];
	reviewedCues?: CaptionCue[];
}): DeliverySnapshot {
	const { scene, fps, deliveryId, source, captions, shortStyle } = input;
	if (shortStyle) {
		const { srt, cueCount } = shortCaptionDelivery({ tracks: scene.tracks });
		return {
			deliveryId,
			scene,
			fps,
			shortStyle,
			srt,
			source: { ...source, cueCount },
		};
	}
	const cues = (reviewedCues ?? buildCaptionCues({
		tracks: scene.tracks,
		captions,
		spellings,
		sequenceEnd: source.durationSeconds,
		sequenceId: source.sequenceId,
	})).filter(({ text }) => text.trim());
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
	cues,
}: {
	editor: EditorCore;
	cues?: CaptionCue[];
}): DeliverySnapshot {
	const input = captureDelivery({ editor });
	return {
		...snapshotWithSpellings({
			input,
			spellings: useCaptionsStore.getState().spellings,
			reviewedCues: cues,
		}),
		requestedRevision: input.source.revision,
	};
}

/** Applies the saved spellings to the cues of the approved edit. */
export async function prepareDelivery({
	input,
}: {
	input: DeliveryInput;
}): Promise<DeliverySnapshot> {
	const spellings = input.shortStyle
		? []
		: await useCaptionsStore.getState().loadSpellings();
	return snapshotWithSpellings({ input, spellings });
}

/** The files the tracks play, by what identifies them on disk. */
function usedMedia({
	scene: { tracks, projectItems },
	legacyMedia,
}: {
	scene: ExportScene;
	legacyMedia: boolean;
}) {
	const used = referencedMedia({ tracks });
	return projectItems
		.filter(({ id }) => used.has(id))
		.map(({ id, type, file, originalLocation }) => {
			const location = legacyMedia && originalLocation;
			const identity = location
				? {
						size: location.size,
						lastModified: location.lastModified,
						path: location.path,
					}
				: recordingIdentity({ file, legacy: legacyMedia });
			return {
				id,
				type,
				...(!("contentHash" in identity) && {
					name: location ? location.path.split("/").at(-1) : file.name,
				}),
				...identity,
			};
		})
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
	shortStyle,
	legacyMedia = false,
}: Pick<DeliverySnapshot, "scene" | "fps" | "srt" | "shortStyle"> & {
	legacyMedia?: boolean;
}): Promise<string> {
	/* eslint-disable opencut/prefer-object-params -- JSON.stringify calls replacers with (key, value). */
	const withoutBuffers = (key: string, value: unknown) =>
		key === "buffer" ? undefined : value;
	/* eslint-enable opencut/prefer-object-params */
	const render = {
		canvasSize: scene.canvasSize,
		background: scene.background,
		fps,
		media: usedMedia({ scene, legacyMedia }),
		master: scene.master,
		...(shortStyle && { shortStyle, outputSize: scene.outputSize }),
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

/** Runs one step of a delivery, reporting it and naming it in any failure. */
async function deliveryStep<T>({
	name,
	run,
	signal,
	onStep,
}: {
	name: DeliveryStep;
	run: () => Promise<T>;
	signal: AbortSignal;
	onStep: (step: DeliveryStep) => void;
}): Promise<T> {
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

/**
 * Reserves a staging folder for this Export click's MP4 and SRT, or returns
 * the pair an earlier attempt already published.
 */
export async function beginDelivery({
	snapshot,
	signal,
	onStep,
}: {
	snapshot: DeliverySnapshot;
	signal: AbortSignal;
	onStep: (step: DeliveryStep) => void;
}): Promise<{ exportId: string } | { committed: ExportRecord }> {
	const source: ExportSource = {
		...snapshot.source,
		fingerprint: await deliveryFingerprint(snapshot),
	};
	return deliveryStep({
		name: "render",
		signal,
		onStep,
		run: async () =>
			beginResultSchema.parse(
				await callSplice({
					method: "exports.begin",
					params: {
						...source,
						deliveryId: snapshot.deliveryId,
						...(snapshot.includeSrt === false && { includeSrt: false }),
					},
				}),
			),
	});
}

/** Drops a staged export; nothing was published from it. */
export function abortDelivery({ exportId }: { exportId: string }): void {
	void callSplice({ method: "exports.abort", params: { exportId } }).catch(
		() => {},
	);
}

/**
 * Writes the SRT beside the staged MP4, then publishes the pair under
 * Exports. The staging stays on failure, so a retry can publish it without
 * rendering again.
 */
export async function finishDelivery({
	snapshot,
	exportId,
	signal,
	onStep,
}: {
	snapshot: DeliverySnapshot;
	exportId: string;
	signal: AbortSignal;
	onStep: (step: DeliveryStep) => void;
}): Promise<ExportRecord> {
	if (snapshot.includeSrt !== false)
		await deliveryStep({
			name: "upload-captions",
			signal,
			onStep,
			run: () =>
				uploadExportFile({
					exportId,
					kind: "srt",
					body: new Blob([snapshot.srt], { type: "application/x-subrip" }),
					signal,
				}),
		});
	return deliveryStep({
		name: "publish",
		signal,
		onStep,
		run: async () =>
			exportRecordSchema.parse(
				await callSplice({
					method: "exports.publish",
					params: { exportId },
				}),
			),
	});
}

/** One published export, as the history lists it. */
export const listedExportSchema = exportRecordSchema.extend({
	files: z.object({ mp4: z.string(), srt: z.string().optional() }),
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
