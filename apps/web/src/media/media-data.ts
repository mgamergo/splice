import {
	denoisedAudioUrlForPath,
	isFootagePath,
	mediaUrlForPath,
	MEDIA_CONTENT_HEADER,
	MEDIA_VERSION_HEADER,
	MEDIA_VERSION_PARAM,
} from "@splice/bridge";
import { type AudioCapableClip, isNoiseReduced } from "@/timeline/audio-state";
import { BlobSource, UrlSource, type Source } from "mediabunny";
import { ensureMediaSession } from "@/bridge/media-session";
import type { DiskMedia, MediaData, ProjectItem } from "./types";

export function isDiskMedia(data: MediaData): data is DiskMedia {
	return !(data instanceof Blob) && data.kind === "disk";
}

/**
 * A mediabunny source that reads the bytes where they live. `signal` stops its
 * requests: disposing the Input alone leaves a request that is still waiting
 * on its headers running.
 */
export function createMediaSource({
	data,
	signal,
}: {
	data: MediaData;
	signal?: AbortSignal;
}): Source {
	if (!isDiskMedia(data)) return new BlobSource(data);
	return new UrlSource(data.url, {
		requestInit: { credentials: "same-origin" },
		// The default retries forever, which a missing file would hit.
		getRetryDelay: (previousAttempts) =>
			!signal?.aborted && previousAttempts < 3 ? 0.5 : null,
		...(signal && { fetchFn: createAbortableFetch({ signal }) }),
	});
}

/** fetch, also stopped by `signal` on top of the signal each request brings. */
function createAbortableFetch({
	signal,
}: {
	signal: AbortSignal;
}): typeof fetch {
	trackAbortReason({ signal });
	const abortableFetch = (...[input, init]: Parameters<typeof fetch>) =>
		fetch(input, {
			...init,
			signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
		});
	return Object.assign(abortableFetch, { preconnect: fetch.preconnect });
}

/**
 * mediabunny rethrows a failed read-ahead request that no read is waiting on
 * ("so it doesn't get swallowed"), so aborting `signal` while one waits on its
 * headers leaves an unhandled rejection. Reads that are waiting still get the
 * rejection; the page only stops reporting, as uncaught, a rejection whose
 * reason is an aborted media signal's own reason.
 */
const abortReasons = new WeakSet<object>();
let ignoringAbortedReads = false;

function trackAbortReason({ signal }: { signal: AbortSignal }): void {
	const track = () => {
		if (isObject(signal.reason)) abortReasons.add(signal.reason);
	};
	if (signal.aborted) track();
	else signal.addEventListener("abort", track, { once: true });
	if (!ignoringAbortedReads && typeof window !== "undefined") {
		ignoringAbortedReads = true;
		window.addEventListener("unhandledrejection", ignoreAbortedRead);
	}
}

/** The page's `unhandledrejection` listener; exported for tests. */
export function ignoreAbortedRead(
	event: Pick<PromiseRejectionEvent, "reason" | "preventDefault">,
): void {
	if (isObject(event.reason) && abortReasons.has(event.reason))
		event.preventDefault();
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

/** Give each render URL the version verified for that job. */
export function versionedMediaUrl({
	url,
	version,
}: {
	url: string;
	version: string;
}): string {
	return `${url}${url.includes("?") ? "&" : "?"}${MEDIA_VERSION_PARAM}=${encodeURIComponent(version)}`;
}

/**
 * Where a clip's audio is read from, and a key for caching what's decoded from
 * it. With noise reduction on, a disk item's audio comes from the WAV `splice`
 * renders, so playback and export hear the same thing; the file itself is
 * never changed. Items stored in the browser have no render and play as is.
 */
export function clipAudioMedia({
	clip,
	projectItem,
}: {
	clip: AudioCapableClip;
	projectItem: ProjectItem;
}): { file: MediaData; sourceKey: string } {
	const { file } = projectItem;
	if (!isNoiseReduced({ clip }) || !isDiskMedia(file))
		return { file, sourceKey: projectItem.id };
	const url = denoisedAudioUrlForPath(file.path);
	const version = file.expectedVersion;
	return {
		file: {
			...file,
			url: version ? versionedMediaUrl({ url, version }) : url,
			type: "audio/wav",
		},
		sourceKey: `${projectItem.id}:denoised`,
	};
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
	signal,
	includeContentHash = true,
	fullHash = false,
}: {
	path: string;
	signal?: AbortSignal;
	includeContentHash?: boolean;
	fullHash?: boolean;
}): Promise<DiskMedia | null> {
	if (!isFootagePath(path)) {
		return null;
	}
	const url = mediaUrlForPath(path);
	const head = () =>
		fetch(url, {
			method: "HEAD",
			credentials: "same-origin",
			cache: "no-store",
			signal,
			...(includeContentHash && {
				headers: { [MEDIA_CONTENT_HEADER]: fullHash ? "1" : "sample" },
			}),
		});
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
		version: response.headers.get(MEDIA_VERSION_HEADER) ?? undefined,
		contentHash: response.headers.get(MEDIA_CONTENT_HEADER) ?? undefined,
	};
}
