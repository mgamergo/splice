import { tracksWithMusicDucking } from "@/mix/music";
import type { MixLoudness } from "@splice/bridge/mix";
import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SequenceExporter } from "@/services/renderer/sequence-exporter";
import type { StreamTargetChunk } from "mediabunny";
import { buildScene } from "@/services/renderer/scene-builder";
import { createTimelineAudioReader } from "@/media/audio";
import { MAX_TRUE_PEAK_DBTP } from "@splice/bridge/ops";
import { calculateTotalDuration } from "@/timeline";
import type { SequenceTracks } from "@/timeline/types";
import { formatTimecode } from "opencut-wasm";
import { frameRateToFloat } from "@/fps/utils";
import { downloadBlob } from "@/utils/browser";
import type { ProjectItem } from "@/media/types";
import type { TBackground, TCanvasSize } from "@/project/types";

/** What an export renders: a sequence's tracks, the media they play and the frame. */
export interface ExportScene {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	canvasSize: TCanvasSize;
	/** Delivery size when it differs from the saved composition. */
	outputSize?: TCanvasSize;
	background: TBackground;
	master?: Pick<MixLoudness, "gainDb" | "ceilingDbtp">;
}

/**
 * The master an export applies before the mix has been measured: no gain,
 * and the same true-peak limiter measured mixes use, so a clipping peak is
 * caught without buffering the whole mix to find it.
 */
const UNMEASURED_MASTER = { gainDb: 0, ceilingDbtp: MAX_TRUE_PEAK_DBTP };

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private comparisons = 0;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	get isComparingFrames(): boolean {
		return this.comparisons > 0;
	}

	/** The comparison and the active preview share a compositor. */
	async compareFrames(render: () => Promise<void>) {
		this.comparisons++;
		try {
			await render();
		} finally {
			this.comparisons--;
		}
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or sequence to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/** Renders the active sequence to a file; resolves as cancelled once `signal` aborts. */
	async exportProject({
		options,
		onProgress,
		signal,
		scene,
		stream,
	}: {
		options: ExportOptions;
		/** Writes the file here as it renders instead of returning it. */
		stream?: WritableStream<StreamTargetChunk>;
		onProgress?: ({ progress }: { progress: number }) => void;
		signal: AbortSignal;
		/**
		 * Everything to render as it was when the export was asked for, in place
		 * of the active sequence, media and project settings.
		 */
		scene?: ExportScene;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio } = options;

		try {
			signal.throwIfAborted();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			if (!scene) {
				const sequence = this.editor.sequences.getActiveSequence();
				const projectItems = this.editor.media.getProjectItems();
				scene = {
					tracks: tracksWithMusicDucking({
						sequence,
						projectItems,
						projectSources: activeProject.captions?.sources,
					}),
					projectItems,
					canvasSize: activeProject.settings.canvasSize,
					background: activeProject.settings.background,
					master: sequence.mix?.loudness,
				};
			}
			const { tracks, projectItems, canvasSize, outputSize, background, master } = scene;

			const duration = calculateTotalDuration({ tracks });
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;

			// Audio streams in second by second beside the frames, so a long
			// sequence starts rendering at once and never holds its whole mix.
			const reader = includeAudio
				? createTimelineAudioReader({
						tracks,
						projectItems,
						duration,
						signal,
					})
				: null;

			const sequence = buildScene({
				tracks,
				projectItems,
				duration,
				canvasSize,
				background,
			});

			const exporter = new SequenceExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				outputSize,
				fps: exportFps,
				format,
				quality,
				shouldIncludeAudio: !!includeAudio,
				audioBlocks: reader?.blocks({ master: master ?? UNMEASURED_MASTER }),
				stream,
				signal,
			});

			exporter.on("progress", (progress) => onProgress?.({ progress }));

			const exported = await exporter.export({ rootNode: sequence });

			if (signal.aborted) {
				return { success: false, cancelled: true };
			}

			if (!exported) {
				return { success: false, error: "Export failed to produce buffer" };
			}

			return "buffer" in exported
				? { success: true, buffer: exported.buffer, encoder: exported.encoder }
				: { success: true, streamed: true, encoder: exported.encoder };
		} catch (error) {
			if (signal.aborted) {
				return { success: false, cancelled: true };
			}
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
