import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromSequences } from "@/timeline/sequences";
import { mediaUrlForPath } from "@splice/bridge";
import { isDiskMedia, probeDiskMedia } from "@/media/media-data";
import type { DiskMedia, ProjectItem } from "@/media/types";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import {
	type StorageCapacityCheckResult,
	StorageQuotaExceededError,
	evaluateStorageCapacity,
	isStorageQuotaExceededError,
	readStorageQuotaStatus,
} from "./quota";
import type {
	ProjectItemData,
	StorageConfig,
	SerializedProject,
	SerializedSequence,
} from "./types";
import type { SavedSoundsData, SavedSound, SoundEffect } from "@/sounds/types";
import { isSupportedProjectFormat } from "./format";
import type { Marker, SequenceTracks, TSequence } from "@/timeline";
import { roundMediaTime } from "@/wasm";

function normalizeMarkers({ raw }: { raw: unknown }): Marker[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Marker | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Marker => b !== null);
}

/**
 * Rebuilds a disk item from its stored path. A file that left the Footage folder
 * still loads, marked missing, so its clips stay in the sequence until it's relinked.
 */
async function loadDiskProjectItem({
	metadata,
	diskPath,
}: {
	metadata: ProjectItemData;
	diskPath: string;
}): Promise<ProjectItem> {
	const probed = await probeDiskMedia({ path: diskPath }).catch(() => null);
	const file: DiskMedia = probed ?? {
		kind: "disk",
		path: diskPath,
		url: mediaUrlForPath(diskPath),
		name: metadata.name,
		type: "application/octet-stream",
		size: metadata.size,
		lastModified: metadata.lastModified,
	};
	return {
		id: metadata.id,
		name: metadata.name,
		type: metadata.type,
		file,
		url: file.url,
		width: metadata.width,
		height: metadata.height,
		duration: metadata.duration,
		fps: metadata.fps,
		hasAudio: metadata.hasAudio,
		thumbnailUrl: metadata.thumbnailUrl,
		ephemeral: metadata.ephemeral,
		missing: probed === null,
	};
}

class StorageService {
	private projectsAdapter: IndexedDBAdapter<SerializedProject>;
	private savedSoundsAdapter: IndexedDBAdapter<SavedSoundsData>;
	private config: StorageConfig;

	constructor() {
		this.config = {
			projectsDb: "splice-projects",
			mediaDb: "splice-media",
			savedSoundsDb: "splice-saved-sounds",
			version: 1,
		};

		this.projectsAdapter = new IndexedDBAdapter<SerializedProject>({
			dbName: this.config.projectsDb,
			storeName: "projects",
			version: this.config.version,
		});

		this.savedSoundsAdapter = new IndexedDBAdapter<SavedSoundsData>({
			dbName: this.config.savedSoundsDb,
			storeName: "saved-sounds",
			version: this.config.version,
		});
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<ProjectItemData>({
			dbName: `${this.config.mediaDb}-${projectId}`,
			storeName: "media-metadata",
			version: this.config.version,
		});

		const projectItemsAdapter = new OPFSAdapter(`splice-media-files-${projectId}`);

		return { mediaMetadataAdapter, projectItemsAdapter };
	}

	async canStoreFile({
		size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		const quotaStatus = await readStorageQuotaStatus();
		return evaluateStorageCapacity({
			requiredBytes: size,
			quotaStatus,
		});
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	private stripAudioBuffers({ tracks }: { tracks: SequenceTracks }): SequenceTracks {
		return {
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				clips: track.clips.map((clip) => {
					const { buffer: _buffer, ...rest } = clip;
					return rest;
				}),
			})),
		};
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromSequences({ sequences: project.sequences });
		const serializedSequences: SerializedSequence[] = project.sequences.map((sequence) => ({
			id: sequence.id,
			name: sequence.name,
			isMain: sequence.isMain,
			tracks: this.stripAudioBuffers({ tracks: sequence.tracks }),
			markers: sequence.markers,
			createdAt: sequence.createdAt.toISOString(),
			updatedAt: sequence.updatedAt.toISOString(),
		}));

		const serializedProject: SerializedProject = {
			metadata: {
				id: project.metadata.id,
				name: project.metadata.name,
				thumbnail: project.metadata.thumbnail,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			sequences: serializedSequences,
			currentSequenceId: project.currentSequenceId,
			settings: project.settings,
			version: project.version,
			timelineViewState: project.timelineViewState,
		};

		await this.projectsAdapter.set({
			key: project.metadata.id,
			value: serializedProject,
		});
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		const serializedProject = await this.projectsAdapter.get(id);

		if (!serializedProject) return null;

		if (!isSupportedProjectFormat({ version: serializedProject.version })) {
			console.warn("[storage] Skipping project with unsupported format:", {
				id,
				version: serializedProject.version,
			});
			return null;
		}

		if (
			typeof serializedProject !== "object" ||
			serializedProject === null ||
			typeof serializedProject.metadata !== "object" ||
			serializedProject.metadata === null
		) {
			console.warn(
				"[storage] Skipping malformed project entry (missing metadata):",
				{ id, entry: serializedProject },
			);
			return null;
		}

		const sequences =
			serializedProject.sequences?.map((sequence) => ({
				id: sequence.id,
				name: sequence.name,
				isMain: sequence.isMain,
				tracks: sequence.tracks,
				markers: normalizeMarkers({ raw: sequence.markers }),
				createdAt: new Date(sequence.createdAt),
				updatedAt: new Date(sequence.updatedAt),
			})) ?? [];

		const project: TProject = {
			metadata: {
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromSequences({ sequences }),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			},
			sequences,
			currentSequenceId: serializedProject.currentSequenceId || "",
			settings: serializedProject.settings,
			version: serializedProject.version,
			timelineViewState: serializedProject.timelineViewState,
		};

		return { project };
	}

	async loadAllProjects(): Promise<TProject[]> {
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		const serializedProjects = await this.projectsAdapter.getAll();

		const metadata: TProjectMetadata[] = [];
		for (const serializedProject of serializedProjects) {
			if (
				typeof serializedProject !== "object" ||
				serializedProject === null ||
				typeof serializedProject.metadata !== "object" ||
				serializedProject.metadata === null
			) {
				console.warn(
					"[storage] Skipping malformed project entry (missing metadata):",
					serializedProject,
				);
				continue;
			}

			// Listing a project that loadProject would reject leaves it unopenable.
			if (!isSupportedProjectFormat({ version: serializedProject.version })) {
				continue;
			}

			metadata.push({
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromSequences({
							sequences: (serializedProject.sequences ?? []) as unknown as TSequence[],
						}),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			});
		}

		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.projectsAdapter.remove(id);
	}

	async saveProjectItem({
		projectId,
		projectItem,
	}: {
		projectId: string;
		projectItem: ProjectItem;
	}): Promise<void> {
		const { mediaMetadataAdapter, projectItemsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const metadata: ProjectItemData = {
			id: projectItem.id,
			name: projectItem.name,
			type: projectItem.type,
			size: projectItem.file.size,
			lastModified: projectItem.file.lastModified,
			width: projectItem.width,
			height: projectItem.height,
			duration: projectItem.duration,
			fps: projectItem.fps,
			hasAudio: projectItem.hasAudio,
			thumbnailUrl: projectItem.thumbnailUrl,
			ephemeral: projectItem.ephemeral,
		};

		const data = projectItem.file;
		if (isDiskMedia(data)) {
			// The file stays on disk; only its path and metadata are stored.
			await mediaMetadataAdapter.set({
				key: projectItem.id,
				value: { ...metadata, diskPath: data.path },
			});
			return;
		}

		try {
			await projectItemsAdapter.set({
				key: projectItem.id,
				value: data,
			});
			await mediaMetadataAdapter.set({
				key: projectItem.id,
				value: metadata,
			});
		} catch (error) {
			try {
				await projectItemsAdapter.remove(projectItem.id);
			} catch {
				// Ignore cleanup failures so the original storage error is preserved.
			}

			if (this.isQuotaExceededError({ error })) {
				throw new StorageQuotaExceededError({
					requiredBytes: data.size,
				});
			}

			throw error;
		}
	}

	async loadProjectItem({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<ProjectItem | null> {
		const { mediaMetadataAdapter, projectItemsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const metadata = await mediaMetadataAdapter.get(id);
		if (metadata?.diskPath) {
			return loadDiskProjectItem({ metadata, diskPath: metadata.diskPath });
		}
		const file = await projectItemsAdapter.get(id);

		if (!file || !metadata) return null;

		let url: string;
		if (metadata.type === "image" && (!file.type || file.type === "")) {
			try {
				const text = await file.text();
				if (text.trim().startsWith("<svg")) {
					const svgBlob = new Blob([text], { type: "image/svg+xml" });
					url = URL.createObjectURL(svgBlob);
				} else {
					url = URL.createObjectURL(file);
				}
			} catch {
				url = URL.createObjectURL(file);
			}
		} else {
			url = URL.createObjectURL(file);
		}

		return {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			file,
			url,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			fps: metadata.fps,
			hasAudio: metadata.hasAudio,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
		};
	}

	async loadAllProjectItems({
		projectId,
	}: {
		projectId: string;
	}): Promise<ProjectItem[]> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();
		const mediaItems: ProjectItem[] = [];

		for (const id of mediaIds) {
			const item = await this.loadProjectItem({ projectId, id });
			if (item) {
				mediaItems.push(item);
			}
		}

		return mediaItems;
	}

	async deleteProjectItem({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, projectItemsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			projectItemsAdapter.remove(id),
			mediaMetadataAdapter.remove(id),
		]);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, projectItemsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaMetadataAdapter.clear(),
			projectItemsAdapter.clear(),
		]);
	}

	async clearAllData(): Promise<void> {
		await this.projectsAdapter.clear();
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isOPFSSupported: this.isOPFSSupported(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();

		return {
			mediaItems: mediaIds.length,
		};
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		try {
			const savedSoundsData = await this.savedSoundsAdapter.get("user-sounds");
			return (
				savedSoundsData || {
					sounds: [],
					lastModified: new Date().toISOString(),
				}
			);
		} catch (error) {
			console.error("Failed to load saved sounds:", error);
			return { sounds: [], lastModified: new Date().toISOString() };
		}
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			if (currentData.sounds.some((sound) => sound.id === soundEffect.id)) {
				return; // Already saved
			}

			const savedSound: SavedSound = {
				id: soundEffect.id,
				name: soundEffect.name,
				username: soundEffect.username,
				previewUrl: soundEffect.previewUrl,
				downloadUrl: soundEffect.downloadUrl,
				duration: soundEffect.duration,
				tags: soundEffect.tags,
				license: soundEffect.license,
				savedAt: new Date().toISOString(),
			};

			const updatedData: SavedSoundsData = {
				sounds: [...currentData.sounds, savedSound],
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to save sound effect:", error);
			throw error;
		}
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			const updatedData: SavedSoundsData = {
				sounds: currentData.sounds.filter((sound) => sound.id !== soundId),
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to remove saved sound:", error);
			throw error;
		}
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		try {
			const currentData = await this.loadSavedSounds();
			return currentData.sounds.some((sound) => sound.id === soundId);
		} catch (error) {
			console.error("Failed to check if sound is saved:", error);
			return false;
		}
	}

	async clearSavedSounds(): Promise<void> {
		try {
			await this.savedSoundsAdapter.remove("user-sounds");
		} catch (error) {
			console.error("Failed to clear saved sounds:", error);
			throw error;
		}
	}

	isOPFSSupported(): boolean {
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return this.isIndexedDBSupported() && this.isOPFSSupported();
	}
}

export const storageService = new StorageService();
export { StorageService };
