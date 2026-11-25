import type { ImportItemsResult, ItemSummary } from "@splice/bridge";
import { ALL_FORMATS, Input } from "mediabunny";
import type { EditorCore } from "@/core";
import { createMediaSource, isDiskMedia, probeDiskMedia } from "./media-data";
import { readVideoFile } from "./mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";
import { pinDiskMedia } from "./recording-verification";
import type { DiskMedia, MediaType, ProjectItem } from "./types";

export function mediaTypeOf({ mime }: { mime: string }): MediaType | null {
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("image/")) return "image";
	return null;
}

export function summarizeItem(item: ProjectItem): ItemSummary {
	return {
		id: item.id,
		name: item.name,
		type: item.type,
		duration: item.duration ?? null,
		path: isDiskMedia(item.file) ? item.file.path : null,
		missing: item.missing ?? false,
		...(item.recordingChange && { recordingChange: item.recordingChange.kind }),
	};
}

async function readAudioDuration({
	media,
}: {
	media: DiskMedia;
}): Promise<number> {
	const input = new Input({
		source: createMediaSource({ data: media }),
		formats: ALL_FORMATS,
	});
	try {
		return await input.computeDuration();
	} finally {
		input.dispose();
	}
}

function readImage({
	url,
}: {
	url: string;
}): Promise<{ thumbnailUrl: string; width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		image.addEventListener("load", () => {
			try {
				resolve({
					thumbnailUrl: renderThumbnailDataUrl({
						width: image.naturalWidth,
						height: image.naturalHeight,
						draw: ({ context, width, height }) =>
							context.drawImage(image, 0, 0, width, height),
					}),
					width: image.naturalWidth,
					height: image.naturalHeight,
				});
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			}
		});
		image.addEventListener("error", () =>
			reject(new Error("Could not load image")),
		);
		image.src = url;
	});
}

export async function describeDiskMedia({
	media,
	type,
}: {
	media: DiskMedia;
	type: MediaType;
}): Promise<Omit<ProjectItem, "id">> {
	const base = { name: media.name, type, file: media, url: media.url };
	if (type === "video") {
		const video = await readVideoFile({ file: media });
		if (!video.canDecode) {
			throw new Error(
				`${video.codec ?? "This video codec"} can't be decoded in this browser. Convert it to H.264 MP4.`,
			);
		}
		return {
			...base,
			duration: video.duration,
			width: video.width,
			height: video.height,
			fps: Number.isFinite(video.fps) ? Math.round(video.fps) : undefined,
			hasAudio: video.hasAudio,
			thumbnailUrl: video.thumbnailUrl ?? undefined,
		};
	}
	if (type === "audio") {
		return { ...base, duration: await readAudioDuration({ media }) };
	}
	return { ...base, ...(await readImage({ url: media.url })) };
}

const PROJECT_CHANGED =
	"The creator closed or switched the project during the import";

/** Imports in flight, by project and path, so overlapping requests share one item. */
const inFlight = new Map<string, Promise<ProjectItem>>();

/** How an import reads a file; replaceable so tests don't need a server or decoder. */
export interface ImportReaders {
	probe: typeof probeDiskMedia;
	describe: typeof describeDiskMedia;
}

const defaultReaders: ImportReaders = {
	probe: probeDiskMedia,
	describe: describeDiskMedia,
};

async function importOne({
	editor,
	projectId,
	path,
	isBlocked,
	isStale,
	beforeCommit,
	readers,
}: {
	editor: EditorCore;
	projectId: string;
	path: string;
	isBlocked: () => boolean;
	isStale: () => boolean;
	beforeCommit?: () => void;
	readers: ImportReaders;
}): Promise<ProjectItem> {
	const media = await readers.probe({ path });
	if (!media) {
		throw new Error("Not found in the Footage folder");
	}
	const type = mediaTypeOf({ mime: media.type });
	if (!type) {
		throw new Error(`Unsupported file type ${media.type}`);
	}
	const projectItem = await readers.describe({
		media: pinDiskMedia(media),
		type,
	});
	// Probing takes a while; the creator may have stopped the agent or switched projects.
	if (isBlocked()) {
		throw new Error("The creator stopped the agent");
	}
	if (isStale()) {
		throw new Error(PROJECT_CHANGED);
	}
	beforeCommit?.();
	const item = await editor.media.addProjectItem({ projectId, projectItem });
	if (!item) {
		throw new Error("Couldn't save the project item");
	}
	return item;
}

/**
 * Adds files under the Footage folder to the open project as project items that
 * reference the files in place. Importing a path that's already an item returns it.
 */
export async function importDiskItems({
	editor,
	paths,
	isBlocked,
	beforeCommit,
	readers = defaultReaders,
}: {
	editor: EditorCore;
	paths: string[];
	isBlocked: () => boolean;
	beforeCommit?: () => void;
	readers?: ImportReaders;
}): Promise<ImportItemsResult> {
	const project = editor.project.getActiveOrNull();
	if (!project) {
		throw new Error("No project is open");
	}
	const projectId = project.metadata.id;
	const generation = editor.media.getGeneration();
	// A project switch clears the library before the next project becomes active.
	const isStale = () =>
		editor.media.getGeneration() !== generation ||
		editor.project.getActiveOrNull()?.metadata.id !== projectId;
	const result: ImportItemsResult = { imported: [], failed: [] };
	for (const path of paths) {
		if (isBlocked()) {
			result.failed.push({ path, error: "The creator stopped the agent" });
			continue;
		}
		if (isStale()) {
			result.failed.push({ path, error: PROJECT_CHANGED });
			continue;
		}
		const key = `${projectId}\n${generation}\n${path}`;
		// In-flight first: an item still being saved shows in the library already,
		// and its save can still fail.
		let pending = inFlight.get(key);
		if (!pending) {
			const existing = editor.media
				.getProjectItems()
				.find((item) => isDiskMedia(item.file) && item.file.path === path);
			if (existing) {
				result.imported.push(summarizeItem(existing));
				continue;
			}
			pending = importOne({
				editor,
				projectId,
				path,
				isBlocked,
				isStale,
				beforeCommit,
				readers,
			}).finally(() => inFlight.delete(key));
			inFlight.set(key, pending);
		}
		try {
			result.imported.push(summarizeItem(await pending));
		} catch (error) {
			result.failed.push({
				path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}
