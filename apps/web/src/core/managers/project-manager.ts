import { PROJECT_FORMATS, type ProjectFormat } from "@splice/bridge";
import type { EditorCore } from "@/core";
import type {
	TProject,
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
	TProjectSettings,
	TTimelineViewState,
} from "@/project/types";
import type {
	ExportOptions,
	ExportQuality,
	ExportResult,
	ExportState,
} from "@/export";
import { ExportJobs } from "@/export/export-jobs";
import {
	DeliveryError,
	type DeliverySnapshot,
	publishDelivery,
	takeDeliverySnapshot,
} from "@/export/deliver";
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
	/** A Horizontal export that can be retried: its snapshot and any finished render. */
	private delivery: {
		snapshot: DeliverySnapshot;
		quality: ExportQuality;
		video: ArrayBuffer | null;
	} | null = null;

	constructor(private editor: EditorCore) {}

	async createNewProject({
		name,
		format = "horizontal",
	}: {
		name: string;
		format?: ProjectFormat;
	}): Promise<string> {
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
				format,
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
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		this.resetCommandHistory();
		this.editor.save.pause();
		this.editor.media.clearAllProjectItems();
		this.editor.sequences.clearSequences();

		try {
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

	async saveCurrentProject(): Promise<void> {
		const project = this.active;
		if (!project) return;

		try {
			const sequences = this.editor.sequences.getSequences();
			const updatedProject = {
				...project,
				sequences,
				metadata: {
					...project.metadata,
					duration: getProjectDurationFromSequences({ sequences }),
					updatedAt: new Date(),
				},
			};

			await storageService.saveProject({ project: updatedProject });
			// Edits made during this write belong to the pending save.
			if (this.active === project) this.active = updatedProject;
			this.updateMetadata(updatedProject);
		} catch (error) {
			console.error("Failed to save project:", error);
		}
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
	}: {
		options: ExportOptions;
		onExported?: ({ buffer }: { buffer: ArrayBuffer }) => void;
	}): Promise<ExportResult> {
		this.exportState = { isExporting: true, progress: 0, result: null };
		// Register the job before notifying, so a subscriber that cancels on
		// seeing the export start cancels this one.
		const job = this.exportJobs.start({
			run: ({ signal, isCurrent }) =>
				this.editor.renderer.exportProject({
					options,
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
			onExported?.({ buffer: result.buffer });
		}
		return result;
	}

	/**
	 * Exports the active Horizontal sequence as it is now: renders the MP4,
	 * times the SRT against the same tracks and publishes both under Exports.
	 */
	deliver({ quality }: { quality: ExportQuality }): Promise<ExportResult> {
		this.delivery = {
			snapshot: takeDeliverySnapshot({ editor: this.editor }),
			quality,
			video: null,
		};
		return this.runDelivery();
	}

	/** Retries a failed Horizontal export, reusing its render if it finished. */
	retryDelivery(): Promise<ExportResult> {
		if (!this.delivery)
			return Promise.resolve({ success: false, error: "Nothing to retry." });
		return this.runDelivery();
	}

	private async runDelivery(): Promise<ExportResult> {
		const delivery = this.delivery;
		if (!delivery) return { success: false, error: "Nothing to export." };
		this.exportState = {
			isExporting: true,
			progress: delivery.video ? 0.9 : 0,
			result: null,
			step: delivery.video ? "upload-video" : "render",
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
				if (!delivery.video) {
					const rendered = await this.editor.renderer.exportProject({
						options: {
							format: "mp4",
							quality: delivery.quality,
							fps: this.getActive().settings.fps,
							includeAudio: true,
						},
						signal,
						tracks: delivery.snapshot.tracks,
						mix: delivery.snapshot.mix,
						// Rendering is most of the work; writing the files is the rest.
						onProgress: ({ progress }) => update({ progress: progress * 0.9 }),
					});
					if (rendered.cancelled) return rendered;
					if (!rendered.success || !rendered.buffer)
						return {
							success: false,
							error: rendered.error ?? "The render produced no video.",
							failedStep: "render",
						};
					delivery.video = rendered.buffer;
				}
				try {
					const record = await publishDelivery({
						snapshot: delivery.snapshot,
						video: delivery.video,
						signal,
						onStep: (step) => update({ step }),
					});
					return { success: true, record };
				} catch (error) {
					if (signal.aborted) return { success: false, cancelled: true };
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
						failedStep: error instanceof DeliveryError ? error.step : "publish",
					};
				}
			},
		});
		this.notify();
		const { result, isCurrent } = await job;
		if (!isCurrent()) return { success: false, cancelled: true };
		// The render is kept only to retry a failure.
		if (result.success || result.cancelled) this.delivery = null;
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
		this.delivery = null;
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
				this.active = updatedProject;
				this.notify();
			}

			this.updateMetadata(updatedProject);
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
