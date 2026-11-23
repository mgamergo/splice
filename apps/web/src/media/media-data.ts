import { isFootagePath, mediaUrlForPath } from "@splice/bridge";
import { BlobSource, UrlSource, type Source } from "mediabunny";
import { ensureMediaSession } from "@/bridge/media-session";
import type { DiskMedia, MediaData, ProjectItem } from "./types";

export function isDiskMedia(data: MediaData): data is DiskMedia {
	return !(data instanceof Blob) && data.kind === "disk";
}

/** A mediabunny source that reads the bytes where they live. */
export function createMediaSource(data: MediaData): Source {
	return isDiskMedia(data)
		? new UrlSource(data.url, {
				requestInit: { credentials: "same-origin" },
				// The default retries forever, which a missing file would hit.
				getRetryDelay: (previousAttempts) =>
					previousAttempts < 3 ? 0.5 : null,
			})
		: new BlobSource(data);
}

/**
 * Items whose bytes can be read. A disk item whose file left Footage keeps its
 * clips in the sequence, but renderers and the audio mix skip it, so one missing
 * file doesn't break every frame it overlaps.
 */
export function playableProjectItems(items: ProjectItem[]): ProjectItem[] {
	return items.filter((item) => !item.missing);
}

/** Looks up a file under Footage through `splice`, or returns null if it's gone. */
export async function probeDiskMedia({
	path,
}: {
	path: string;
}): Promise<DiskMedia | null> {
	if (!isFootagePath(path)) {
		return null;
	}
	const url = mediaUrlForPath(path);
	const head = () => fetch(url, { method: "HEAD", credentials: "same-origin" });
	let response = await head();
	// The media cookie is missing (a new browser session): get one and try again.
	if (response.status === 401 && (await ensureMediaSession())) {
		response = await head();
	}
	if (!response.ok) {
		return null;
	}
	const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
	return {
		kind: "disk",
		path,
		url,
		name: path.split("/").pop() ?? path,
		type: response.headers.get("content-type") ?? "application/octet-stream",
		size: Number(response.headers.get("content-length") ?? 0),
		lastModified: Number.isFinite(lastModified) ? lastModified : 0,
	};
}
