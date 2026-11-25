import type {
	ItemVerification,
	RelinkItemRequest,
	RelinkItemResult,
} from "@splice/bridge/items";
import {
	bindRecording,
	compareRecording,
	probeRecording,
	verifyDiskItem,
} from "@/media/recording-verification";
import {
	describeDiskMedia,
	mediaTypeOf,
	summarizeItem,
} from "@/media/import-disk";
import { isDiskMedia, probeDiskMedia } from "@/media/media-data";
import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { ProjectItem } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { BatchCommand, RemoveProjectItemCommand } from "@/commands";

type VerificationResult = {
	item: ReturnType<typeof summarizeItem>;
	verification: ItemVerification;
};

export class MediaManager {
	private projectItems: ProjectItem[] = [];
	private isLoading = false;
	private pendingSaves = new Map<string, Promise<void>>();
	private checking = new Set<string>();
	private verifying:
		| { generation: number; result: Promise<VerificationResult[]> }
		| undefined;
	private listeners = new Set<() => void>();
	/** Changes whenever the library is cleared (a project closes or another loads). */
	private generation = 0;

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

		const save = storageService.saveProjectItem({
			projectId,
			projectItem: newProjectItem,
		});
		this.pendingSaves.set(newProjectItem.id, save);
		this.projectItems = [...this.projectItems, newProjectItem];
		this.notify();

		try {
			await save;
			// The save is async; don't change another project's frame rate.
			if (this.editor.project.getActiveOrNull()?.metadata.id === projectId) {
				this.editor.project.ratchetFpsForImportedMedia({
					importedProjectItems: [newProjectItem],
				});
			}
			return newProjectItem;
		} catch (error) {
			console.error("Failed to save project item:", error);
			this.projectItems = this.projectItems.filter(
				(projectItem) => projectItem.id !== newProjectItem.id,
			);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough browser storage", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		} finally {
			this.pendingSaves.delete(newProjectItem.id);
		}
	}

	async waitForProjectItemSaves({
		items,
	}: {
		items: Iterable<string>;
	}): Promise<void> {
		await Promise.all([...items].map((id) => this.pendingSaves.get(id)));
	}

	removeProjectItem({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): void {
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
		const removable = uniqueIds.filter(
			(id) => !this.editor.project.isCheckpointMedia({ projectId, id }),
		);
		if (removable.length !== uniqueIds.length)
			toast.error("Media used by an approved cut must stay in the library.");
		if (removable.length === 0) {
			return;
		}

		const command =
			removable.length === 1
				? new RemoveProjectItemCommand({
						projectId,
						projectItemId: removable[0],
					})
				: new BatchCommand(
						removable.map(
							(id) =>
								new RemoveProjectItemCommand({
									projectId,
									projectItemId: id,
								}),
						),
					);

		this.editor.command.execute({ command });
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		const generation = this.generation;
		this.isLoading = true;
		this.notify();

		try {
			const projectItems = await storageService.loadAllProjectItems({
				projectId,
			});
			const project = this.editor.project.getActive();
			if (project.metadata.id !== projectId || generation !== this.generation)
				return;
			// Approvals written before project items stored hashes already prove the original bytes.
			const approved = new Map(
				project.approval?.checkpoints.flatMap(({ footage }) =>
					footage.filter(({ contentHash }) => contentHash)
						.map((entry) => [entry.projectItemId, entry] as const),
				),
			);
			this.projectItems = projectItems.map((item) => {
				const { file } = item;
				const saved = approved.get(item.id);
				return isDiskMedia(file) &&
					!file.contentHash &&
					saved?.contentHash &&
					saved.path === file.path &&
					saved.size === file.size &&
					saved.lastModified === file.lastModified
					? { ...item, file: { ...file, contentHash: saved.contentHash } }
					: item;
			});
			this.notify();
			await this.verifyRecordings();
			if (generation !== this.generation) return;
			const missing = this.projectItems.filter(
				(item) => item.missing && !item.recordingChange,
			);
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

	private isCurrent({
		item,
		generation,
	}: {
		item: ProjectItem;
		generation: number;
	}): boolean {
		return this.generation === generation && this.projectItems.includes(item);
	}

	private publishRecording({
		item,
		next,
	}: {
		item: ProjectItem;
		next: ProjectItem;
	}): void {
		this.projectItems = this.projectItems.map((current) =>
			current === item ? next : current,
		);
		if (
			item.file !== next.file ||
			item.missing !== next.missing ||
			item.recordingChange?.version !== next.recordingChange?.version
		) {
			videoCache.clearAll();
			if (item.replacementId !== next.replacementId) {
				waveformCache.clearSource({ sourceKey: item.id });
				waveformCache.clearSource({ sourceKey: `${item.id}:denoised` });
			}
			this.editor.command.bumpRevision();
		}
		this.notify();
	}

	verifyRecordings(): Promise<VerificationResult[]> {
		const generation = this.generation;
		const projectId = this.editor.project.getActiveOrNull()?.metadata.id;
		if (!projectId) return Promise.resolve([]);
		if (this.verifying?.generation === generation) return this.verifying.result;
		const result = this.verifyProjectRecordings({
			projectId,
			generation,
		}).finally(() => {
			if (this.verifying?.result === result) this.verifying = undefined;
		});
		this.verifying = { generation, result };
		return result;
	}

	private async verifyProjectRecordings({
		projectId,
		generation,
	}: {
		projectId: string;
		generation: number;
	}): Promise<VerificationResult[]> {
		const results = [];
		for (const item of this.projectItems) {
			if (
				!isDiskMedia(item.file) ||
				this.pendingSaves.has(item.id) ||
				!this.isCurrent({ item, generation })
			)
				continue;
			const key = JSON.stringify([generation, item.id]);
			// A relink in progress owns the item until it has published the new location.
			if (this.checking.has(key)) continue;
			this.checking.add(key);
			try {
				const verified = await verifyDiskItem({ item });
				if (!this.isCurrent({ item, generation })) continue;
				const { item: next, verification } = verified;
				const changed =
					next.missing !== item.missing ||
					next.recordingChange?.version !== item.recordingChange?.version ||
					next.recordingChange?.kind !== item.recordingChange?.kind ||
					(isDiskMedia(next.file) && next.file.version !== item.file.version);
				if (
					(verification === "match" || verification === "backfilled") &&
					(changed || !item.file.contentHash)
				) {
					await storageService.saveProjectItem({
						projectId,
						projectItem: next,
					});
				}
				if (!this.isCurrent({ item, generation })) continue;
				if (changed || verification === "backfilled")
					this.publishRecording({ item, next });
				results.push({ item: summarizeItem(next), verification });
			} finally {
				this.checking.delete(key);
			}
		}
		return results;
	}

	async relinkRecording({
		request,
		beforeCommit,
	}: {
		request: RelinkItemRequest;
		beforeCommit?: () => void;
	}): Promise<RelinkItemResult> {
		const projectId = this.editor.project.getActive().metadata.id;
		const generation = this.generation;
		const item = this.projectItems.find(
			({ id }) => id === request.projectItemId,
		);
		if (!item || !isDiskMedia(item.file) || this.pendingSaves.has(item.id))
			throw new Error("Select a project item from Footage.");
		const original = item.file;
		const key = JSON.stringify([generation, item.id]);
		if (this.checking.has(key))
			throw new Error("This recording is being checked. Try again.");
		this.checking.add(key);
		try {
			const candidate = await probeRecording({ original, path: request.path });
			if (!candidate?.contentHash || !candidate.version)
				throw new Error("The recording is unavailable in Footage.");
			if (mediaTypeOf({ mime: candidate.type }) !== item.type)
				throw new Error("Choose a file of the same media type.");
			const compared = compareRecording({ original, candidate });
			const verification = compared === "backfilled" ? "match" : compared;
			const replacement = verification !== "match";
			if (
				(replacement && !request.replace) ||
				(request.expectedVersion &&
					request.expectedVersion !== candidate.version)
			)
				return {
					kind: "confirmation-required",
					verification: verification === "match" ? "unverified" : verification,
					version: candidate.version,
				};
			const bound = bindRecording({ item, file: candidate });
			let next = bound;
			if (replacement) {
				const described = await describeDiskMedia({
					media: isDiskMedia(bound.file) ? bound.file : candidate,
					type: item.type,
				});
				next = {
					...bound,
					...described,
					name: item.name,
					replacementId: generateUUID(),
					originalLocation: undefined,
				};
			}
			const current = await probeDiskMedia({
				path: request.path,
				includeContentHash: false,
			});
			if (current?.version !== candidate.version)
				throw new Error(
					"The recording changed during relink. Verify it again.",
				);
			const checkCurrent = () => {
				beforeCommit?.();
				if (!this.isCurrent({ item, generation }))
					throw new Error("The project changed. Relink the recording again.");
			};
			checkCurrent();
			if (replacement) {
				await this.editor.project.discardRecordingAnalysis({
					projectId,
					projectItemId: item.id,
				});
				checkCurrent();
			}
			const save = storageService.saveProjectItem({ projectId, projectItem: next });
			this.pendingSaves.set(item.id, save);
			try {
				await save;
			} finally {
				this.pendingSaves.delete(item.id);
			}
			if (this.isCurrent({ item, generation }))
				this.publishRecording({ item, next });
			return { kind: "relinked", verification, item: summarizeItem(next) };
		} finally {
			this.checking.delete(key);
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		waveformCache.clearAll();

		const removable = this.projectItems.filter(
			({ id }) => !this.editor.project.isCheckpointMedia({ projectId, id }),
		);
		removable.forEach((projectItem) => {
			if (projectItem.url) {
				URL.revokeObjectURL(projectItem.url);
			}
			if (projectItem.thumbnailUrl) {
				URL.revokeObjectURL(projectItem.thumbnailUrl);
			}
		});

		const mediaIds = new Set(removable.map(({ id }) => id));
		this.projectItems = this.projectItems.filter(({ id }) => !mediaIds.has(id));
		this.notify();

		try {
			await Promise.all(
				[...mediaIds].map((id) =>
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
		this.generation++;
		this.notify();
	}

	/**
	 * Lets async work, like an agent import, detect that the library it started
	 * against was cleared, even before the next project becomes active.
	 */
	getGeneration(): number {
		return this.generation;
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
