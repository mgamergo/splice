import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { toast } from "sonner";
import type { ProjectItem } from "@/media/types";
import { generateUUID } from "@/utils/id";
import { storageService } from "@/services/storage/service";
import type { FrameRate } from "opencut-wasm";
import { hasMediaId } from "@/timeline/clip-utils";
import { frameRatesEqual, getHighestImportedVideoFps } from "@/fps/utils";
import { UpdateProjectSettingsCommand } from "@/commands/project";

export class AddProjectItemCommand extends Command {
	private projectItemId: string;
	private savedProjectItems: ProjectItem[] | null = null;
	private createdProjectItem: ProjectItem | null = null;
	private previousProjectFps: FrameRate | null = null;
	private appliedProjectFps: FrameRate | null = null;

	constructor({
		projectId,
		projectItem,
	}: {
		projectId: string;
		projectItem: Omit<ProjectItem, "id">;
	}) {
		super();
		this.projectId = projectId;
		this.projectItem = projectItem;
		this.projectItemId = generateUUID();
	}

	private projectId: string;
	private projectItem: Omit<ProjectItem, "id">;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedProjectItems = [...editor.media.getProjectItems()];

		this.createdProjectItem = {
			...this.projectItem,
			id: this.projectItemId,
		};

		editor.media.setProjectItems({
			projectItems: [...this.savedProjectItems, this.createdProjectItem],
		});
		this.previousProjectFps = editor.project.getActiveOrNull()?.settings.fps ?? null;
		this.appliedProjectFps = editor.project.ratchetFpsForImportedMedia({
			importedProjectItems: [this.createdProjectItem],
		});

		storageService
			.saveProjectItem({
				projectId: this.projectId,
				projectItem: this.createdProjectItem,
			})
			.catch((error) => {
				console.error("Failed to save media item:", error);

				const currentProjectItems = editor.media.getProjectItems();
				editor.media.setProjectItems({
					projectItems: currentProjectItems.filter((projectItem) => projectItem.id !== this.projectItemId),
				});

				const currentTracks = editor.sequences.getActiveSequence().tracks;
				const orphanedClips: Array<{ trackId: string; clipId: string }> =
					[];

				for (const track of [
					...currentTracks.overlay,
					currentTracks.main,
					...currentTracks.audio,
				]) {
					for (const clip of track.clips) {
						if (hasMediaId(clip) && clip.mediaId === this.projectItemId) {
							orphanedClips.push({
								trackId: track.id,
								clipId: clip.id,
							});
						}
					}
				}

				if (orphanedClips.length > 0) {
					editor.timeline.deleteClips({ clips: orphanedClips });
				}

				this.restoreProjectFpsAfterFailedSave({ editor });

				if (storageService.isQuotaExceededError({ error })) {
					toast.error("Not enough browser storage", {
						description: error instanceof Error ? error.message : undefined,
					});
				}
			});

		return undefined;
	}

	undo(): void {
		if (this.savedProjectItems) {
			const editor = EditorCore.getInstance();
			editor.media.setProjectItems({ projectItems: this.savedProjectItems });

			if (this.createdProjectItem) {
				storageService
					.deleteProjectItem({ projectId: this.projectId, id: this.projectItemId })
					.catch((error) => {
						console.error("Failed to delete media item on undo:", error);
					});
			}
		}
	}

	getProjectItemId(): string {
		return this.projectItemId;
	}

	private restoreProjectFpsAfterFailedSave({
		editor,
	}: {
		editor: EditorCore;
	}): void {
		if (this.previousProjectFps === null || this.appliedProjectFps === null) return;

		const activeProject = editor.project.getActiveOrNull();
		if (!activeProject) return;
		if (
			!this.appliedProjectFps ||
			!frameRatesEqual({
				a: activeProject.settings.fps,
				b: this.appliedProjectFps,
			})
		)
			return;

		const highestRemainingVideoFps = getHighestImportedVideoFps({
			projectItems: editor.media.getProjectItems(),
		});
		const appliedFpsFloat = this.appliedProjectFps.numerator / this.appliedProjectFps.denominator;
		if (
			highestRemainingVideoFps !== null &&
			highestRemainingVideoFps >= appliedFpsFloat
		) {
			return;
		}

		new UpdateProjectSettingsCommand({ fps: this.previousProjectFps }).execute();
	}
}
