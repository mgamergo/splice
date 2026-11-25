import type { ItemVerification } from "@splice/bridge/items";
import { isDiskMedia, probeDiskMedia, versionedMediaUrl } from "./media-data";
import type { DiskMedia, ProjectItem } from "./types";

/** Byte identity is path independent. Legacy metadata can only establish a baseline in place. */
export function compareRecording({
	original,
	candidate,
}: {
	original: DiskMedia;
	candidate: DiskMedia;
}): Exclude<ItemVerification, "missing"> {
	if (!candidate.contentHash) return "unverified";
	if (original.contentHash?.startsWith("sample-v1:")) {
		// A sampled baseline can only be upgraded while the verified file version
		// is still at the recorded path.
		return original.path === candidate.path &&
			original.version &&
			original.version === candidate.version
			? "backfilled"
			: "unverified";
	}
	if (original.contentHash)
		return original.contentHash === candidate.contentHash ? "match" : "changed";
	if (original.path !== candidate.path) return "unverified";
	return (!original.version || original.version === candidate.version) &&
		original.size === candidate.size &&
		original.lastModified === candidate.lastModified
		? "backfilled"
		: "changed";
}

export async function probeRecording({
	original,
	path = original.path,
	signal,
	onProgress,
}: {
	original: DiskMedia;
	path?: string;
	signal?: AbortSignal;
	onProgress?: (progress: number) => void;
}): Promise<DiskMedia | null> {
	if (
		path === original.path &&
		original.version &&
		original.contentHash &&
		!original.contentHash.startsWith("sample-v1:")
	) {
		const current = await probeDiskMedia({
			path,
			signal,
			includeContentHash: false,
		});
		if (!current) return null;
		if (current.version === original.version)
			return { ...current, contentHash: original.contentHash };
	}
	return probeDiskMedia({ path, signal, onProgress });
}

export function pinDiskMedia(file: DiskMedia): DiskMedia {
	if (!file.version || file.expectedVersion === file.version) return file;
	return {
		...file,
		url: versionedMediaUrl({ url: file.url, version: file.version }),
		expectedVersion: file.version,
	};
}

export function bindRecording({
	item,
	file,
}: {
	item: ProjectItem;
	file: DiskMedia;
}): ProjectItem {
	const pinned = pinDiskMedia(file);
	const previous = item.file;
	const moved =
		isDiskMedia(previous) &&
		(previous.path !== file.path ||
			previous.lastModified !== file.lastModified);
	return {
		...item,
		file: pinned,
		url: pinned.url,
		missing: false,
		recordingChange: undefined,
		originalLocation:
			item.originalLocation ??
			(moved
				? {
						path: previous.path,
						size: previous.size,
						lastModified: previous.lastModified,
					}
				: undefined),
	};
}

export async function verifyDiskItem({
	item,
}: {
	item: ProjectItem;
}): Promise<{ item: ProjectItem; verification: ItemVerification }> {
	const original = item.file;
	if (!isDiskMedia(original))
		throw new Error("This project item is stored in the browser.");
	const candidate = await probeRecording({ original });
	if (!candidate)
		return {
			item: { ...item, missing: true, recordingChange: undefined },
			verification: "missing",
		};
	const verification = compareRecording({ original, candidate });
	if (verification === "match" || verification === "backfilled")
		return { item: bindRecording({ item, file: candidate }), verification };
	return {
		item: {
			...item,
			missing: true,
			recordingChange: { kind: verification, version: candidate.version },
		},
		verification,
	};
}
