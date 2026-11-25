import type { ProjectItemData } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

/**
 * A file under the creator's Footage folder, streamed by `splice` instead of
 * being copied into browser storage (ADR 0002).
 */
export interface DiskMedia {
	kind: "disk";
	/** Relative to the Footage folder, with forward slashes. */
	path: string;
	/** Same-origin URL that `splice` serves the file at, with range support. */
	url: string;
	name: string;
	/** MIME type. */
	type: string;
	size: number;
	lastModified: number;
	/** Changes when the file at this path is replaced or edited. */
	version?: string;
	/** A render URL is locked to this version, including its denoised audio. */
	expectedVersion?: string;
	/** Sampled fingerprint, or a full SHA-256 from an existing approved cut. */
	contentHash?: string;
}

/** A project item's bytes: uploaded into browser storage, or on disk. */
export type MediaData = File | DiskMedia;

export interface ProjectItem extends Omit<
	ProjectItemData,
	"size" | "lastModified" | "diskPath" | "diskContentHash" | "diskVersion"
> {
	file: MediaData;
	url?: string;
	/** A disk item whose file is no longer in the Footage folder. */
	missing?: boolean;
	/** A candidate at the saved path needs approval before playback can use it. */
	recordingChange?: {
		kind: "changed" | "unverified";
		version: string | undefined;
	};
}
