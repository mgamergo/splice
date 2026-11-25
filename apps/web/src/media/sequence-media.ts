import type { MediaData, ProjectItem } from "@/media/types";
import type { SequenceTracks } from "@/timeline/types";
import { isDiskMedia, probeDiskMedia, versionedMediaUrl } from "./media-data";

/** Media referenced by the sequence, including its audio and overlay tracks. */
export function referencedMedia({
	tracks,
}: {
	tracks: SequenceTracks;
}): Map<string, string> {
	const used = new Map<string, string>();
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const clip of track.clips) {
			if ("mediaId" in clip) used.set(clip.mediaId, clip.name);
		}
	}
	return used;
}

export function requireSequenceMedia({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): ProjectItem[] {
	const items = new Map(projectItems.map((item) => [item.id, item]));
	return [...referencedMedia({ tracks })].map(([id, name]) => {
		const item = items.get(id);
		if (!item || item.missing || (item.type !== "audio" && !item.url))
			throw new Error(
				`${item?.name ?? name} is unavailable. Restore or relink it and try again.`,
			);
		return item;
	});
}

/** A path-independent fingerprint when the server can identify the bytes. */
export function recordingIdentity({
	file,
	legacy = false,
}: {
	file: MediaData;
	legacy?: boolean;
}) {
	return !legacy && isDiskMedia(file) && file.contentHash
		? { contentHash: file.contentHash }
		: {
				size: file.size,
				lastModified: file.lastModified,
				...(isDiskMedia(file) && { path: file.path }),
			};
}

/** Verify that the current bytes still match a captured render's inputs. */
export async function verifySequenceMedia({
	tracks,
	projectItems,
	signal,
	checkIdentity = true,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	signal?: AbortSignal;
	checkIdentity?: boolean;
}): Promise<void> {
	const used = requireSequenceMedia({ tracks, projectItems });
	await Promise.all(
		used.map(async ({ file, name }) => {
			if (!isDiskMedia(file)) return;
			const current = await probeDiskMedia({
				path: file.path,
				signal,
				includeContentHash: false,
			});
			if (!current)
				throw new Error(
					`${name} is unavailable. Restore or relink it and try again.`,
				);
			if (
				checkIdentity &&
				(file.version
					? current.version !== file.version
					: current.size !== file.size ||
						current.lastModified !== file.lastModified)
			)
				throw new Error(
					`${name} changed on disk. Reopen the project and review the recording before starting a new export.`,
				);
		}),
	);
}

export function pinRenderMedia({
	projectItems,
}: {
	projectItems: ProjectItem[];
}): ProjectItem[] {
	return projectItems.map((item) => {
		const { file } = item;
		if (!isDiskMedia(file) || !file.version) return item;
		const url = versionedMediaUrl({ url: file.url, version: file.version });
		return {
			...item,
			url,
			file: { ...file, url, expectedVersion: file.version },
		};
	});
}
