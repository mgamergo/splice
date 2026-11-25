import { Command, type CommandResult } from "@/commands/base-command";
import { isDiskMedia } from "@/media/media-data";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import type { ProjectItem } from "@/media/types";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { hasMediaId } from "@/timeline/clip-utils";
import type { SequenceTracks } from "@/timeline";

export class RemoveProjectItemCommand extends Command {
	private savedProjectItems: ProjectItem[] | null = null;
	private savedTracks: SequenceTracks | null = null;
	private removedProjectItem: ProjectItem | null = null;

	constructor({
		projectId,
		projectItemId,
	}: {
		projectId: string;
		projectItemId: string;
	}) {
		super();
		this.projectId = projectId;
		this.projectItemId = projectItemId;
	}

	private projectId: string;
	private projectItemId: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		if (
			editor.project.isCheckpointMedia({
				projectId: this.projectId,
				id: this.projectItemId,
			})
		) {
			this.savedTracks = null;
			this.removedProjectItem = null;
			toast.error(
				"This media is used by an approved cut and must stay in the library.",
			);
			return;
		}
		const projectItems = editor.media.getProjectItems();

		this.savedProjectItems = [...projectItems];
		this.savedTracks = editor.sequences.getActiveSequence().tracks;

		this.removedProjectItem =
			projectItems.find((media) => media.id === this.projectItemId) ?? null;

		if (!this.removedProjectItem) {
			console.error("Project item not found:", this.projectItemId);
			return;
		}

		if (this.removedProjectItem.url) {
			URL.revokeObjectURL(this.removedProjectItem.url);
		}
		if (this.removedProjectItem.thumbnailUrl) {
			URL.revokeObjectURL(this.removedProjectItem.thumbnailUrl);
		}

		videoCache.clearVideo({ mediaId: this.projectItemId });
		waveformCache.clearSource({
			sourceKey: buildWaveformSourceKey({
				kind: "media",
				id: this.projectItemId,
			}),
		});

		editor.media.setProjectItems({
			projectItems: projectItems.filter(
				(media) => media.id !== this.projectItemId,
			),
		});

		const clipsToRemove: Array<{ trackId: string; clipId: string }> = [];

		for (const track of [
			...this.savedTracks.overlay,
			this.savedTracks.main,
			...this.savedTracks.audio,
		]) {
			for (const clip of track.clips) {
				if (hasMediaId(clip) && clip.mediaId === this.projectItemId) {
					clipsToRemove.push({ trackId: track.id, clipId: clip.id });
				}
			}
		}

		if (clipsToRemove.length > 0) {
			editor.timeline.deleteClips({ clips: clipsToRemove });
		}

		storageService
			.deleteProjectItem({ projectId: this.projectId, id: this.projectItemId })
			.catch((error) => {
				console.error("Failed to delete media item:", error);
			});
	}

	undo(): void {
		const editor = EditorCore.getInstance();

		if (this.savedProjectItems && this.removedProjectItem) {
			const restoredProjectItem: ProjectItem = {
				...this.removedProjectItem,
				url: isDiskMedia(this.removedProjectItem.file)
					? this.removedProjectItem.file.url
					: URL.createObjectURL(this.removedProjectItem.file),
			};

			editor.media.setProjectItems({
				projectItems: this.savedProjectItems.map((a) =>
					a.id === this.projectItemId ? restoredProjectItem : a,
				),
			});

			storageService
				.saveProjectItem({
					projectId: this.projectId,
					projectItem: restoredProjectItem,
				})
				.catch((error) => {
					console.error("Failed to restore media item on undo:", error);
				});
		}

		if (this.savedTracks) {
			editor.timeline.updateTracks(this.savedTracks);
		}
	}
}
