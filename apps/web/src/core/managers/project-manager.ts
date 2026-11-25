import { invalidateRecordingAnalysis } from "@/media/replacement-analysis";
import { readStyleDefaults, sequenceStyle } from "@/agent/style-profile";
import {
	PROJECT_FORMATS,
	type ProjectFormat,
	type ShortStyle,
} from "@splice/bridge";
import type { EditorCore } from "@/core";
import type { ApprovedCheckpoint } from "@/approval/types";
import {
	pinRenderMedia,
	rebindRenderMedia,
	referencedMedia,
	verifySequenceMedia,
} from "@/media/sequence-media";
import type {
	TProject,
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
	TProjectSettings,
	TTimelineViewState,
} from "@/project/types";
import type {
	DeliveryStep,
	ExportOptions,
	ExportQuality,
	ExportResult,
	ExportState,
} from "@/export";
import { ExportJobs } from "@/export/export-jobs";
import {
	captureDelivery,
	DeliveryError,
	deliveryScene,
	type DeliveryInput,
	type DeliverySnapshot,
	abortDelivery,
	beginDelivery,
	finishDelivery,
	prepareDelivery,
} from "@/export/deliver";
import { createExportFileStream, uploadExportFile } from "@/bridge/splice-api";
import { storageService } from "@/services/storage/service";
import { toast } from "sonner";
import { generateUUID } from "@/utils/id";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import {
	buildDefaultSequence,
	getProjectDurationFromSequences,
} from "@/timeline/sequences";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { PROJECT_FORMAT_VERSION } from "@/services/storage/format";
import { loadFonts } from "@/fonts/google-fonts";
import { DEFAULTS } from "@/timeline/defaults";
import { getClipFontFamilies } from "@/timeline/clip-utils";
import { getRaisedProjectFpsForImportedMedia } from "@/fps/utils";
import type { ProjectItem } from "@/media/types";
import { projectFormat, projectShortStyle } from "@/project/format";
import { BatchCommand } from "@/commands/batch-command";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import { syncGraphics } from "@/agent/graphics";
import { fillExplainerPicture } from "@/agent/explainer-picture";
import { layoutShort } from "@/agent/short-layout";
import { shortSrt } from "@/export/short-srt";
import { useCaptionsStore } from "@/captions/store";

const IDLE_EXPORT_STATE: ExportState = {
	isExporting: false,
	progress: 0,
	result: null,
};

export class ProjectManager {
	private active: TProject | null = null;
	private savedProjects: TProjectMetadata[] = [];
	private isLoading = true;
	private isInitialized = false;
	private invalidProjectIds = new Set<string>();
	private listeners = new Set<() => void>();
	private exportState: ExportState = IDLE_EXPORT_STATE;
	private exportJobs = new ExportJobs();
	private projectWrites = Promise.resolve();
	private pendingCheckpoint: {
		projectId: string;
		checkpoint: ApprovedCheckpoint;
	} | null = null;
	/**
	 * A Horizontal export that can be retried with its approved edit and any
	 * finished snapshot and render.
	 */
	private delivery: {
		input: DeliveryInput | DeliverySnapshot;
		quality: ExportQuality;
		/** The staged export whose MP4 is fully written, kept to retry publishing. */
		staged: string | null;
		encoder?: ExportResult["encoder"];
	} | null = null;

	constructor(private editor: EditorCore) {}

	async createNewProject({
		name,
		format = "horizontal",
		shortStyle = "explainer",
	}: {
		name: string;
		format?: ProjectFormat;
		shortStyle?: ShortStyle;
	}): Promise<string> {
		const styleDefaults = await readStyleDefaults();
		const { width, height, fps } = PROJECT_FORMATS[format];
		const mainSequence = buildDefaultSequence({
			name: "Main sequence",
			isMain: true,
		});
		const newProject: TProject = {
			metadata: {
				id: generateUUID(),
				name,
				duration: getProjectDurationFromSequences({
					sequences: [mainSequence],
				}),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			sequences: [mainSequence],
			currentSequenceId: mainSequence.id,
			settings: {
				styleDefaults,
				format,
				...(format === "short" && { shortStyle }),
				fps: { numerator: fps, denominator: 1 },
				canvasSize: { width, height },
				canvasSizeMode: "preset",
				lastCustomCanvasSize: null,
				originalCanvasSize: null,
				background: {
					type: "color",
					color: DEFAULT_BACKGROUND_COLOR,
				},
			},
			version: PROJECT_FORMAT_VERSION,
		};

		this.resetCommandHistory();
		this.active = newProject;
		this.notify();

		this.editor.media.clearAllProjectItems();
		this.editor.sequences.initializeSequences({
			sequences: newProject.sequences,
			currentSequenceId: newProject.currentSequenceId,
		});

		try {
			await storageService.saveProject({ project: newProject });
			this.updateMetadata(newProject);

			return newProject.metadata.id;
		} catch (error) {
			toast.error("Failed to save new project");
			throw error;
		}
	}

	async loadProject({ id }: { id: string }): Promise<void> {
		this.cancelExport();
		this.clearExportState();
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		this.resetCommandHistory();
		this.editor.save.pause();
		this.editor.media.clearAllProjectItems();
		this.editor.sequences.clearSequences();

		try {
			await this.projectWrites;
			const result = await storageService.loadProject({ id });
			if (!result) {
				throw new Error(`Project with id ${id} not found`);
			}

			const project = result.project;

			this.active = project;
			this.notify();

			if (project.sequences && project.sequences.length > 0) {
				this.editor.sequences.initializeSequences({
					sequences: project.sequences,
					currentSequenceId: project.currentSequenceId,
				});
			}

			// Exports and the caption list apply the saved spellings, so fetching
			// them starts now; an export waits for them.
			if (projectFormat({ project }) === "horizontal")
				useCaptionsStore
					.getState()
					.loadSpellings()
					.catch((error: unknown) =>
						console.error("Failed to load saved spellings:", error),
					);

			await this.editor.media.loadProjectMedia({ projectId: id });

			await loadFonts({
				families: [
					...new Set(
						(project.sequences ?? []).flatMap((sequence) =>
							getClipFontFamilies({ tracks: sequence.tracks }),
						),
					),
				],
			});

			if (!project.metadata.thumbnail) {
				try {
					const didUpdateThumbnail = await this.updateThumbnailFromTimeline();
					if (didUpdateThumbnail) {
						await this.saveCurrentProject();
					}
				} catch (error) {
					console.error("Failed to generate project thumbnail:", error);
				}
			}
		} catch (error) {
			console.error("Failed to load project:", error);
			throw error;
		} finally {
			this.isLoading = false;
			this.notify();
			this.editor.save.resume();
		}
	}

	private queueProjectWrite<T>({
		write,
	}: {
		write: () => Promise<T>;
	}): Promise<T> {
		const result = this.projectWrites.then(write);
		this.projectWrites = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private projectForStorage({ project }: { project: TProject }): TProject {
		const sequences = this.editor.sequences.getSequences();
		return {
			...project,
			sequences,
			metadata: {
				...project.metadata,
				duration: getProjectDurationFromSequences({ sequences }),
				updatedAt: new Date(),
			},
		};
	}

	private async saveProjectSnapshot({
		project,
		replacement,
	}: {
		project: TProject;
		replacement?: ProjectItem;
	}) {
		const events = this.editor.command.getUnsavedCorrections({
			projectId: project.metadata.id,
		});
		await storageService.saveProject({
			project,
			correctionEvents: events,
			replacement,
		});
		this.editor.command.markCorrectionsSaved({ events });
	}

	async saveCurrentProject(): Promise<void> {
		const id = this.active?.metadata.id;
		const generation = this.editor.media.getGeneration();
		if (!id) return;
		try {
			await this.queueProjectWrite({
				write: async () => {
					const project = this.active;
					if (
						project?.metadata.id !== id ||
						this.editor.media.getGeneration() !== generation
					)
						return;
					const updatedProject = this.projectForStorage({ project });
					await this.saveProjectSnapshot({ project: updatedProject });
					// Edits made during this write belong to the pending save.
					if (this.active === project) this.active = updatedProject;
					this.updateMetadata(updatedProject);
				},
			});
		} catch (error) {
			console.error("Failed to save project:", error);
		}
	}

	/** Commit the new recording and its analysis invalidation together. */
	async replaceRecording({
		projectId,
		replacement,
		checkCurrent,
		publish,
	}: {
		projectId: string;
		replacement: ProjectItem;
		checkCurrent: () => Promise<void>;
		publish: () => void;
	}): Promise<void> {
		const generation = this.editor.media.getGeneration();
		await this.queueProjectWrite({
			write: async () => {
				await checkCurrent();
				const project = this.getActive();
				if (
					project.metadata.id !== projectId ||
					this.editor.media.getGeneration() !== generation
				)
					throw new Error("The project changed. Relink the recording again.");
				const invalidated = () =>
					invalidateRecordingAnalysis({
						project: this.getActive(),
						sequences: this.editor.sequences.getSequences(),
						projectItemId: replacement.id,
					});
				const snapshot = {
					...this.projectForStorage({ project }),
					...invalidated(),
				};
				await this.saveProjectSnapshot({ project: snapshot, replacement });
				if (
					this.active?.metadata.id !== projectId ||
					this.editor.media.getGeneration() !== generation
				)
					throw new Error("The project changed. Relink the recording again.");
				const updated = invalidated();
				this.setActiveProject({ project: { ...this.getActive(), ...updated } });
				this.editor.sequences.setSequences({ sequences: updated.sequences });
				// Older undo snapshots can still contain the discarded words.
				this.editor.command.clearUndoHistory();
				publish();
				this.editor.save.markDirty();
			},
		});
	}

	isCheckpointMedia({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): boolean {
		const checkpoints =
			this.active?.metadata.id === projectId
				? (this.active.approval?.checkpoints ?? [])
				: [];
		const pending = this.pendingCheckpoint;
		return [
			...checkpoints,
			...(pending?.projectId === projectId ? [pending.checkpoint] : []),
		].some(({ tracks }) => referencedMedia({ tracks }).has(id));
	}

	saveCheckpoint({
		projectId,
		mediaGeneration,
		checkpoint,
		matches,
	}: {
		projectId: string;
		mediaGeneration: number;
		checkpoint: ApprovedCheckpoint;
		matches: (latest: ApprovedCheckpoint) => boolean;
	}): Promise<{ checkpoint: ApprovedCheckpoint; saved: boolean }> {
		const isCurrent = () =>
			this.active?.metadata.id === projectId &&
			this.editor.media.getGeneration() === mediaGeneration;
		return this.queueProjectWrite({
			write: async () => {
				const project = this.active;
				if (!project || !isCurrent())
					throw new Error("The project changed. Open Review and try again.");
				const checkpoints = project.approval?.checkpoints ?? [];
				const latest = checkpoints.findLast(
					({ sequenceId }) => sequenceId === checkpoint.sequenceId,
				);
				if (latest && matches(latest))
					return { checkpoint: latest, saved: false };

				const nextCheckpoints = [...checkpoints, checkpoint].sort(
					(a, b) =>
						a.approvedAt.localeCompare(b.approvedAt) || a.revision - b.revision,
				);
				this.pendingCheckpoint = { projectId, checkpoint };
				try {
					const capturedItems = checkpoint.footage.map(
						({ projectItemId }) => projectItemId,
					);
					await this.editor.media.waitForProjectItemSaves({
						items: capturedItems,
					});
					if (!isCurrent())
						throw new Error("The project changed. Open Review and try again.");
					const mediaIds = new Set(
						this.editor.media.getProjectItems().map(({ id }) => id),
					);
					if (capturedItems.some((id) => !mediaIds.has(id)))
						throw new Error(
							"Media was removed while saving the approved cut. Review it and try again.",
						);

					const beforeWrite = this.getActive();
					const updatedProject = this.projectForStorage({
						project: {
							...beforeWrite,
							approval: {
								checkpoints: nextCheckpoints,
								dismissals: beforeWrite.approval?.dismissals ?? [],
							},
						},
					});
					try {
						await this.saveProjectSnapshot({ project: updatedProject });
					} catch (error) {
						const detail =
							error instanceof Error ? error.message : String(error);
						throw new Error(`Couldn't save the approved cut. ${detail}`, {
							cause: error,
						});
					}
					if (isCurrent()) {
						const current = this.getActive();
						this.active = {
							...(current === beforeWrite ? updatedProject : current),
							approval: {
								checkpoints: nextCheckpoints,
								dismissals: current.approval?.dismissals ?? [],
							},
						};
					}
					this.updateMetadata(updatedProject);
					if (!isCurrent())
						throw new Error(
							"The project changed while saving the approved cut.",
						);
					return { checkpoint, saved: true };
				} finally {
					this.pendingCheckpoint = null;
				}
			},
		});
	}

	/**
	 * Exports the active sequence and hands a finished file to `onExported`.
	 * Starting an export cancels one still running; the export replaced that
	 * way, even one that already finished, resolves as cancelled and leaves the
	 * export state and the download to the new one.
	 */
	async export({
		options,
		onExported,
		includeSrt = false,
	}: {
		options: ExportOptions;
		onExported?: (files: { buffer: ArrayBuffer; srt?: string }) => void;
		includeSrt?: boolean;
	}): Promise<ExportResult> {
		const project = this.active;
		const sequence =
			project && projectShortStyle({ project })
				? this.editor.sequences.getActiveSequenceOrNull()
				: null;
		const scene =
			project && sequence
				? deliveryScene({
						sequence,
						projectItems: this.editor.media.getProjectItems(),
						projectSources: project.captions?.sources,
						background: project.settings.background,
						shortCanvas: project.settings.canvasSize,
					})
				: undefined;
		const srt =
			scene && includeSrt ? shortSrt({ tracks: scene.tracks }) : undefined;
		this.exportState = { isExporting: true, progress: 0, result: null };
		// Register the job before notifying, so a subscriber that cancels on
		// seeing the export start cancels this one.
		const job = this.exportJobs.start({
			run: ({ signal, isCurrent }) =>
				this.editor.renderer.exportProject({
					options: scene
						? {
								...options,
								format: "mp4",
								includeAudio: true,
								fps: options.fps ?? project?.settings.fps,
							}
						: options,
					scene,
					signal,
					onProgress: ({ progress }) => {
						if (!isCurrent()) return;
						this.exportState = { ...this.exportState, progress };
						this.notify();
					},
				}),
		});
		this.notify();
		const { result, isCurrent } = await job;
		if (!isCurrent()) return { success: false, cancelled: true };

		this.exportState = result.cancelled
			? IDLE_EXPORT_STATE
			: { isExporting: false, progress: this.exportState.progress, result };
		this.notify();
		// A subscriber can start another export from inside notify().
		if (!isCurrent()) return { success: false, cancelled: true };
		if (result.success && result.buffer) {
			onExported?.({ buffer: result.buffer, ...(srt && { srt }) });
		}
		return result;
	}

	/**
	 * Captures the approved edit, renders it, and publishes the files under Exports.
	 */
	async deliver({
		quality,
		acceptStaleGain = false,
		snapshot,
	}: {
		quality: ExportQuality;
		snapshot?: DeliverySnapshot;
		acceptStaleGain?: boolean;
	}): Promise<ExportResult> {
		let input: DeliveryInput | DeliverySnapshot;
		try {
			input =
				snapshot ??
				captureDelivery({
					editor: this.editor,
					approval: { acceptStaleGain },
				});
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		this.dropDelivery();
		this.delivery = {
			input,
			quality,
			staged: null,
		};
		return this.runDelivery();
	}

	/** Retries a failed export, reusing its snapshot and any finished render. */
	retryDelivery(): Promise<ExportResult> {
		if (!this.delivery)
			return Promise.resolve({ success: false, error: "Nothing to retry." });
		const { scene } = this.delivery.input;
		const projectItems = rebindRenderMedia({
			captured: scene.projectItems,
			current: this.editor.media.getProjectItems(),
		});
		if (projectItems !== scene.projectItems) {
			this.delivery.input = {
				...this.delivery.input,
				scene: { ...scene, projectItems: pinRenderMedia({ projectItems }) },
			};
		}
		return this.runDelivery();
	}

	private async runDelivery(): Promise<ExportResult> {
		const delivery = this.delivery;
		if (!delivery) return { success: false, error: "Nothing to export." };
		this.exportState = {
			isExporting: true,
			progress: delivery.staged ? 0.95 : 0,
			result: null,
			step: delivery.staged
				? "upload-captions"
				: "srt" in delivery.input || delivery.input.shortStyle
					? "render"
					: "spellings",
		};
		// Register the job before notifying, as export() does, so a subscriber
		// that cancels on seeing it start cancels this one.
		const job = this.exportJobs.start({
			run: async ({ signal, isCurrent }): Promise<ExportResult> => {
				const update = (patch: Partial<ExportState>) => {
					if (!isCurrent()) return;
					this.exportState = { ...this.exportState, ...patch };
					this.notify();
				};
				if (!("srt" in delivery.input)) {
					try {
						delivery.input = await prepareDelivery({ input: delivery.input });
					} catch (error) {
						if (signal.aborted) return { success: false, cancelled: true };
						return {
							success: false,
							error: `Couldn't load the saved spellings the captions use: ${error instanceof Error ? error.message : String(error)}`,
							failedStep: "spellings",
						};
					}
					if (signal.aborted) return { success: false, cancelled: true };
					update({ step: "render" });
				}
				const snapshot = delivery.input;
				const onStep = (step: DeliveryStep) => update({ step });
				if (!delivery.staged) {
					let exportId: string | null = null;
					try {
						await verifySequenceMedia({ ...snapshot.scene, signal });
						const begun = await beginDelivery({ snapshot, signal, onStep });
						if ("committed" in begun)
							return { success: true, record: begun.committed };
						exportId = begun.exportId;
						const staging = exportId;
						const rendered = await this.editor.renderer.exportProject({
							options: {
								format: "mp4",
								quality: delivery.quality,
								fps: snapshot.fps,
								includeAudio: true,
							},
							signal,
							scene: snapshot.scene,
							// The MP4 goes to Exports' staging folder as it renders.
							createStream: () =>
								createExportFileStream({
									exportId: staging,
									kind: "mp4",
									signal,
								}),
							// Rendering is most of the work; writing the files is the rest.
							onProgress: ({ progress }) =>
								update({ progress: progress * 0.95 }),
						});
						if (rendered.cancelled) {
							abortDelivery({ exportId: staging });
							return rendered;
						}
						// An unavailable source can also make a decoder fail or skip content.
						await verifySequenceMedia({ ...snapshot.scene, signal });
						if (!rendered.success || (!rendered.streamed && !rendered.buffer))
							throw new Error(
								rendered.error ?? "The render produced no video.",
							);
						if (rendered.buffer) {
							const video = rendered.buffer;
							onStep("upload-video");
							await uploadExportFile({
								exportId: staging,
								kind: "mp4",
								body: new Blob([video], { type: "video/mp4" }),
								signal,
							});
						}
						delivery.staged = staging;
						delivery.encoder = rendered.encoder;
					} catch (error) {
						if (exportId) abortDelivery({ exportId });
						if (signal.aborted) return { success: false, cancelled: true };
						return {
							success: false,
							error: error instanceof Error ? error.message : String(error),
							failedStep:
								error instanceof DeliveryError ? error.step : "render",
						};
					}
				}
				try {
					const record = await finishDelivery({
						snapshot,
						exportId: delivery.staged,
						signal,
						onStep,
					});
					return { success: true, record, encoder: delivery.encoder };
				} catch (error) {
					const failedStep =
						error instanceof DeliveryError ? error.step : "publish";
					// A cancel drops the delivery, so its staging goes too. A publish
					// may have gone through with its answer lost: drop the staging
					// (splice ignores the abort once publishing owns it) and let Retry
					// ask begin, which knows. A failed SRT write keeps it for Retry.
					if (signal.aborted || failedStep === "publish") {
						abortDelivery({ exportId: delivery.staged });
						delivery.staged = null;
					}
					if (signal.aborted) return { success: false, cancelled: true };
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
						failedStep,
					};
				}
			},
		});
		this.notify();
		const { result, isCurrent } = await job;
		if (!isCurrent()) return { success: false, cancelled: true };
		// The render is kept only to retry a failure.
		if (result.success || result.cancelled) this.delivery = null;
		const requestedRevision =
			delivery.input.requestedRevision ?? delivery.input.source.revision;
		if (
			result.success &&
			this.editor.command.getRevision() !== requestedRevision
		) {
			result.newerEdit = true;
			toast.success(
				"Exported the approved revision. A newer edit is available.",
			);
		}
		this.exportState = result.cancelled
			? IDLE_EXPORT_STATE
			: {
					isExporting: false,
					progress: result.success ? 1 : this.exportState.progress,
					result,
				};
		this.notify();
		return result;
	}

	/** Forgets the delivery kept for Retry, and the MP4 it staged. */
	private dropDelivery(): void {
		const staged = this.delivery?.staged;
		if (staged) abortDelivery({ exportId: staged });
		this.delivery = null;
	}

	cancelExport(): void {
		this.exportJobs.cancel();
	}

	/**
	 * Whether an export, a cancelled one included, is still drawing on the
	 * compositor's canvas. It can outlast `isExporting`: closing the export
	 * dialog clears that before the cancelled export has stopped.
	 */
	isExportRunning(): boolean {
		return this.exportJobs.isRunning();
	}

	clearExportState(): void {
		this.dropDelivery();
		this.exportState = IDLE_EXPORT_STATE;
		this.notify();
	}

	getExportState(): ExportState {
		return this.exportState;
	}

	async loadAllProjects(): Promise<void> {
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		try {
			try {
				const metadata = await storageService.loadAllProjectsMetadata();
				this.savedProjects = metadata;
				this.notify();
			} catch (error) {
				console.error("Failed to load projects:", error);
			} finally {
				this.isLoading = false;
				this.isInitialized = true;
				this.notify();
			}
		} catch (error) {
			console.error("Failed to run migrations:", error);
			this.isLoading = false;
			this.isInitialized = true;
			this.notify();
		}
	}

	async deleteProjects({ ids }: { ids: string[] }): Promise<void> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return;

		try {
			await Promise.all(
				uniqueIds.map((id) =>
					Promise.all([
						storageService.deleteProjectMedia({ projectId: id }),
						storageService.deleteProject({ id }),
					]),
				),
			);

			const idSet = new Set(uniqueIds);
			this.savedProjects = this.savedProjects.filter(
				(project) => !idSet.has(project.id),
			);

			const shouldClearActive =
				this.active && idSet.has(this.active.metadata.id);

			if (shouldClearActive) {
				this.resetCommandHistory();
				this.active = null;
				this.editor.media.clearAllProjectItems();
				this.editor.sequences.clearSequences();
			}

			this.notify();
		} catch (error) {
			console.error("Failed to delete projects:", error);
		}
	}

	closeProject(): void {
		this.resetCommandHistory();
		this.active = null;
		this.notify();

		this.editor.media.clearAllProjectItems();
		this.editor.sequences.clearSequences();
	}

	private resetCommandHistory(): void {
		this.editor.command.clear();
		this.editor.command.bumpRevision();
	}

	async renameProject({
		id,
		name,
	}: {
		id: string;
		name: string;
	}): Promise<void> {
		try {
			await this.queueProjectWrite({
				write: async () => {
					const result = await storageService.loadProject({ id });
					if (!result) {
						toast.error("Project not found", {
							description: "Please try again",
						});
						return;
					}

					const updatedProject: TProject = {
						...result.project,
						metadata: {
							...result.project.metadata,
							name,
							updatedAt: new Date(),
						},
					};

					await storageService.saveProject({ project: updatedProject });

					if (this.active?.metadata.id === id) {
						this.active = {
							...this.active,
							metadata: {
								...this.active.metadata,
								name,
								updatedAt: updatedProject.metadata.updatedAt,
							},
						};
						this.notify();
					}

					this.updateMetadata(updatedProject);
				},
			});
		} catch (error) {
			console.error("Failed to rename project:", error);
			toast.error("Failed to rename project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	}

	async duplicateProjects({ ids }: { ids: string[] }): Promise<string[]> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return [];

		try {
			const getDuplicateBaseName = ({ name }: { name: string }) => {
				const match = name.match(/^\((\d+)\)\s+(.+)$/);
				const number = match ? Number.parseInt(match[1], 10) : null;
				const baseName = match ? match[2] : name;
				return { baseName, number };
			};

			const loadResults = await Promise.all(
				uniqueIds.map(async (projectId) => {
					const result = await storageService.loadProject({ id: projectId });
					return { projectId, project: result?.project ?? null };
				}),
			);

			const missingProjectIds = loadResults
				.filter((result) => !result.project)
				.map((result) => result.projectId);

			if (missingProjectIds.length > 0) {
				toast.error(
					missingProjectIds.length === 1
						? "Project not found"
						: "Projects not found",
					{
						description:
							missingProjectIds.length === 1
								? "Please try again"
								: "Some projects could not be found",
					},
				);
				throw new Error(`Projects not found: ${missingProjectIds.join(", ")}`);
			}

			const projectsToDuplicate = loadResults.flatMap((result) =>
				result.project ? [result.project] : [],
			);

			const maxNumberByBaseName = new Map<string, number>();

			for (const project of this.savedProjects) {
				const { baseName, number } = getDuplicateBaseName({
					name: project.name,
				});

				if (number === null) continue;

				const currentMax = maxNumberByBaseName.get(baseName);
				if (currentMax === undefined || number > currentMax) {
					maxNumberByBaseName.set(baseName, number);
				}
			}

			const nextNumberByBaseName = new Map<string, number>();
			for (const [baseName, maxNumber] of maxNumberByBaseName) {
				nextNumberByBaseName.set(baseName, maxNumber + 1);
			}

			const duplicationPlans = projectsToDuplicate.map((project) => {
				const { baseName } = getDuplicateBaseName({
					name: project.metadata.name,
				});
				const nextNumber = nextNumberByBaseName.get(baseName) ?? 1;
				nextNumberByBaseName.set(baseName, nextNumber + 1);

				const newProjectId = generateUUID();
				const newProject: TProject = {
					...project,
					metadata: {
						...project.metadata,
						id: newProjectId,
						name: `(${nextNumber}) ${baseName}`,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				};

				return {
					newProjectId,
					newProject,
					sourceProjectId: project.metadata.id,
				};
			});

			await Promise.all(
				duplicationPlans.map(({ newProject }) =>
					storageService.saveProject({ project: newProject }),
				),
			);

			await Promise.all(
				duplicationPlans.map(async ({ sourceProjectId, newProjectId }) => {
					const sourceProjectItems = await storageService.loadAllProjectItems({
						projectId: sourceProjectId,
					});

					await Promise.all(
						sourceProjectItems.map((projectItem) =>
							storageService.saveProjectItem({
								projectId: newProjectId,
								projectItem,
							}),
						),
					);
				}),
			);

			for (const { newProject } of duplicationPlans) {
				this.updateMetadata(newProject);
			}

			return duplicationPlans.map((plan) => plan.newProjectId);
		} catch (error) {
			console.error("Failed to duplicate projects:", error);
			toast.error("Failed to duplicate projects", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
			throw error;
		}
	}

	setShortStyle({ style }: { style: ShortStyle }): void {
		const command = this.buildShortStyleCommand({ style });
		if (command) this.editor.command.execute({ command });
	}

	buildShortStyleCommand({
		style,
		skipSequenceId,
	}: {
		style: ShortStyle;
		skipSequenceId?: string;
	}): BatchCommand | undefined {
		const project = this.active;
		if (
			!project ||
			!projectShortStyle({ project }) ||
			project.settings.shortStyle === style
		)
			return;
		const projectItems = this.editor.media.getProjectItems();
		const canvas = project.settings.canvasSize;
		const commands = this.editor.sequences
			.getSequences()
			.flatMap((sequence) => {
				if (sequence.id === skipSequenceId) return [];
				const framed =
					style === "explainer"
						? fillExplainerPicture({ tracks: sequence.tracks, canvas, projectItems })
						: sequence.tracks;
				const reframed = { ...sequence, tracks: framed };
				const synced = syncGraphics({
					sequence: reframed,
					projectItems,
					canvas,
					shortStyle: style,
					style: sequenceStyle({ project, sequence }).values,
				});
				const tracks = layoutShort({
					sequence: { ...reframed, ...synced },
					style,
					canvas,
					projectItems,
					updateHookVisibility: true,
					defaults: sequenceStyle({ project, sequence }).values,
				});
				return !synced && tracks === sequence.tracks
					? []
					: [
							new UpdateSequenceCommand({
								editor: this.editor,
								sequenceId: sequence.id,
								updates: { ...synced, tracks },
								label: "Place Short graphics and captions",
								keepSelection: true,
							}),
						];
			});
		return new BatchCommand([
			new UpdateProjectSettingsCommand({ shortStyle: style }),
			...commands,
		]);
	}

	async updateSettings({
		settings,
		pushHistory = true,
	}: {
		settings: Partial<TProjectSettings>;
		pushHistory?: boolean;
	}): Promise<void> {
		if (!this.active) return;

		const command = new UpdateProjectSettingsCommand(settings);
		if (pushHistory) {
			this.editor.command.execute({ command });
			return;
		}

		command.execute();
	}

	ratchetFpsForImportedMedia({
		importedProjectItems,
	}: {
		importedProjectItems: Array<Pick<ProjectItem, "type" | "fps">>;
	}): import("opencut-wasm").FrameRate | null {
		if (!this.active) return null;

		const nextFps = getRaisedProjectFpsForImportedMedia({
			currentFps: this.active.settings.fps,
			importedProjectItems,
		});
		if (nextFps === null) return null;

		new UpdateProjectSettingsCommand({ fps: nextFps }).execute();
		return nextFps;
	}

	async updateThumbnail({ thumbnail }: { thumbnail: string }): Promise<void> {
		if (!this.active) return;

		const updatedProject: TProject = {
			...this.active,
			metadata: { ...this.active.metadata, thumbnail, updatedAt: new Date() },
		};
		this.active = updatedProject;
		this.notify();
		this.updateMetadata(updatedProject);
		this.editor.save.markDirty();
	}

	async prepareExit(): Promise<void> {
		if (!this.active) return;

		try {
			const didUpdateThumbnail = await this.updateThumbnailFromTimeline();
			if (didUpdateThumbnail) {
				await this.editor.save.flush();
			}
		} catch (error) {
			console.error("Failed to generate project thumbnail on exit:", error);
		}
	}

	getFilteredAndSortedProjects({
		searchQuery,
		sortOption,
	}: {
		searchQuery: string;
		sortOption: TProjectSortOption;
	}): TProjectMetadata[] {
		const filteredProjects = this.savedProjects.filter((project) =>
			project.name.toLowerCase().includes(searchQuery.toLowerCase()),
		);

		const [key, order] = sortOption.split("-") as [
			TProjectSortKey,
			"asc" | "desc",
		];

		const sortedProjects = [...filteredProjects].sort((a, b) => {
			const aValue = a[key];
			const bValue = b[key];

			if (order === "asc") {
				if (aValue < bValue) return -1;
				if (aValue > bValue) return 1;
				return 0;
			}
			if (aValue > bValue) return -1;
			if (aValue < bValue) return 1;
			return 0;
		});

		return sortedProjects;
	}

	isInvalidProjectId({ id }: { id: string }): boolean {
		return this.invalidProjectIds.has(id);
	}

	markProjectIdAsInvalid({ id }: { id: string }): void {
		this.invalidProjectIds.add(id);
		this.notify();
	}

	clearInvalidProjectIds(): void {
		this.invalidProjectIds.clear();
		this.notify();
	}

	getActive(): TProject {
		if (!this.active) {
			throw new Error("No active project");
		}
		return this.active;
	}

	/**
	 * for agents:
	 * in most cases, the project is guaranteed to be active, in which getActive() should be used instead.
	 * for very rare cases, this function may be used.
	 */
	getActiveOrNull(): TProject | null {
		return this.active;
	}

	getTimelineViewState(): TTimelineViewState {
		return this.active?.timelineViewState ?? DEFAULTS.timeline.viewState;
	}

	setTimelineViewState({ viewState }: { viewState: TTimelineViewState }): void {
		if (!this.active) return;
		this.active = {
			...this.active,
			timelineViewState: viewState ?? undefined,
		};
		this.editor.save.markDirty();
		this.notify();
	}

	getSavedProjects(): TProjectMetadata[] {
		return this.savedProjects;
	}

	getIsLoading(): boolean {
		return this.isLoading;
	}

	getIsInitialized(): boolean {
		return this.isInitialized;
	}

	setActiveProject({ project }: { project: TProject }): void {
		this.active = project;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async updateThumbnailFromTimeline(): Promise<boolean> {
		if (!this.active) return false;

		const tracks = this.editor.sequences.getActiveSequence().tracks;
		const projectItems = this.editor.media.getProjectItems();
		const duration = this.editor.timeline.getTotalDuration();
		const { canvasSize, background } = this.active.settings;

		const sequence = buildScene({
			tracks,
			projectItems,
			duration: duration || 1,
			canvasSize,
			background,
		});

		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps: this.active.settings.fps,
		});

		const tempCanvas = document.createElement("canvas");
		tempCanvas.width = canvasSize.width;
		tempCanvas.height = canvasSize.height;

		await renderer.renderToCanvas({
			node: sequence,
			time: 0,
			targetCanvas: tempCanvas,
		});

		const thumbnailDataUrl = tempCanvas.toDataURL("image/png");

		await this.updateThumbnail({ thumbnail: thumbnailDataUrl });
		return true;
	}

	private updateMetadata(project: TProject): void {
		const index = this.savedProjects.findIndex(
			(p) => p.id === project.metadata.id,
		);

		if (index !== -1) {
			this.savedProjects = this.savedProjects.with(index, project.metadata);
		} else {
			this.savedProjects = [project.metadata, ...this.savedProjects];
		}

		this.notify();
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
