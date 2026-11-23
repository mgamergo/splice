import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { ProjectItem } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { BatchCommand, RemoveProjectItemCommand } from "@/commands";

export class MediaManager {
	private projectItems: ProjectItem[] = [];
	private isLoading = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	async addProjectItem({
		projectId,
		projectItem,
	}: {
		projectId: string;
		projectItem: Omit<ProjectItem, "id">;
	}): Promise<ProjectItem | null> {
		const newProjectItem: ProjectItem = {
			...projectItem,
			id: generateUUID(),
		};

		this.projectItems = [...this.projectItems, newProjectItem];
		this.notify();

		try {
			await storageService.saveProjectItem({ projectId, projectItem: newProjectItem });
			// The save is async; don't change another project's frame rate.
			if (this.editor.project.getActiveOrNull()?.metadata.id === projectId) {
				this.editor.project.ratchetFpsForImportedMedia({
					importedProjectItems: [newProjectItem],
				});
			}
			return newProjectItem;
		} catch (error) {
			console.error("Failed to save project item:", error);
			this.projectItems = this.projectItems.filter((projectItem) => projectItem.id !== newProjectItem.id);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough browser storage", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		}
	}

	removeProjectItem({ projectId, id }: { projectId: string; id: string }): void {
		this.removeProjectItems({ projectId, ids: [id] });
	}

	removeProjectItems({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveProjectItemCommand({
						projectId,
						projectItemId: uniqueIds[0],
					})
				: new BatchCommand(
						uniqueIds.map((id) =>
							new RemoveProjectItemCommand({
								projectId,
								projectItemId: id,
							}),
						),
					);

		this.editor.command.execute({ command });
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const projectItems = await storageService.loadAllProjectItems({
				projectId,
			});
			this.projectItems = projectItems;
			this.notify();
			const missing = projectItems.filter((item) => item.missing);
			if (missing.length > 0) {
				toast.warning(
					`${missing.length} project ${missing.length === 1 ? "item is" : "items are"} missing from the Footage folder`,
					{ description: missing.map((item) => item.name).join(", ") },
				);
			}
		} catch (error) {
			console.error("Failed to load project items:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		waveformCache.clearAll();

		this.projectItems.forEach((projectItem) => {
			if (projectItem.url) {
				URL.revokeObjectURL(projectItem.url);
			}
			if (projectItem.thumbnailUrl) {
				URL.revokeObjectURL(projectItem.thumbnailUrl);
			}
		});

		const mediaIds = this.projectItems.map((projectItem) => projectItem.id);
		this.projectItems = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteProjectItem({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear project items from storage:", error);
		}
	}

	clearAllProjectItems(): void {
		videoCache.clearAll();
		waveformCache.clearAll();

		this.projectItems.forEach((projectItem) => {
			if (projectItem.url) {
				URL.revokeObjectURL(projectItem.url);
			}
			if (projectItem.thumbnailUrl) {
				URL.revokeObjectURL(projectItem.thumbnailUrl);
			}
		});

		this.projectItems = [];
		this.notify();
	}

	getProjectItems(): ProjectItem[] {
		return this.projectItems;
	}

	setProjectItems({ projectItems }: { projectItems: ProjectItem[] }): void {
		this.projectItems = projectItems;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
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
