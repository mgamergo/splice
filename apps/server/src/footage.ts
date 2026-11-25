import { type FootageFile, isFootagePath } from "@splice/bridge";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { fileIdentity } from "./file-identity";

export const FOOTAGE_FOLDER = "Footage";

/** Media types the editor can import, by extension. */
const MEDIA_TYPES = new Map<string, string>([
	["mp4", "video/mp4"],
	["m4v", "video/mp4"],
	["mov", "video/quicktime"],
	["mkv", "video/x-matroska"],
	["webm", "video/webm"],
	["wav", "audio/wav"],
	["mp3", "audio/mpeg"],
	["m4a", "audio/mp4"],
	["aac", "audio/aac"],
	["flac", "audio/flac"],
	["ogg", "audio/ogg"],
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["webp", "image/webp"],
	["gif", "image/gif"],
]);

export function mediaTypeForPath(path: string): string | null {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	return MEDIA_TYPES.get(extension) ?? null;
}

function isInside({
	parent,
	child,
}: {
	parent: string;
	child: string;
}): boolean {
	const rel = relative(parent, child);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

/**
 * Resolves a path relative to the Footage folder, following symlinks, or returns
 * null if it escapes the folder or doesn't exist.
 */
export async function resolveFootagePath({
	root,
	path,
}: {
	root: string;
	path: string;
}): Promise<string | null> {
	if (!isFootagePath(path)) {
		return null;
	}
	const segments = path.split("/");
	try {
		const footage = await realpath(join(root, FOOTAGE_FOLDER));
		const resolved = await realpath(join(footage, ...segments));
		if (!isInside({ parent: footage, child: resolved })) {
			return null;
		}
		// A directory named like a video must not look like a present file.
		return (await stat(resolved)).isFile() ? resolved : null;
	} catch {
		return null;
	}
}

const MAX_LISTED_FILES = 5_000;

/** Every importable file under Footage, recursively, sorted by path. */
export async function listFootage({
	root,
}: {
	root: string;
}): Promise<FootageFile[]> {
	const footage = await realpath(join(root, FOOTAGE_FOLDER));
	const files: FootageFile[] = [];
	async function walk(dir: string) {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (files.length >= MAX_LISTED_FILES || entry.name.startsWith("."))
				continue;
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(absolute);
				continue;
			}
			const contentType = mediaTypeForPath(entry.name);
			if (!entry.isFile() || !contentType) continue;
			const info = await stat(absolute);
			files.push({
				path: relative(footage, absolute).split(sep).join("/"),
				size: info.size,
				modifiedAt: info.mtime.toISOString(),
				contentType,
			});
		}
	}
	await walk(footage);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Changes even when a replacement has the same size and modification time. */
export async function footageVersion({
	absolutePath,
}: {
	absolutePath: string;
}): Promise<string> {
	const info = await stat(absolutePath);
	if (!info.isFile()) throw new Error("Footage is unavailable.");
	return createHash("sha256")
		.update([info.dev, ...fileIdentity(info)].join())
		.digest("hex");
}

const footageHashes = new Map<string, Promise<string>>();
const MAX_CACHED_HASHES = 512;

/** Hash the file on demand and share the result between probes of that version. */
export function footageContentHash({
	absolutePath,
	version,
}: {
	absolutePath: string;
	version: string;
}): Promise<string> {
	const cached = footageHashes.get(version);
	if (cached) return cached;
	const pending = (async () => {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(absolutePath))
			hash.update(chunk);
		if ((await footageVersion({ absolutePath })) !== version)
			throw new Error("Footage changed while reading its identity.");
		return hash.digest("hex");
	})().catch((error: unknown) => {
		if (footageHashes.get(version) === pending) footageHashes.delete(version);
		throw error;
	});
	if (footageHashes.size >= MAX_CACHED_HASHES) {
		const oldest = footageHashes.keys().next();
		if (!oldest.done) footageHashes.delete(oldest.value);
	}
	footageHashes.set(version, pending);
	return pending;
}

/** Serves a file with HTTP range support, which media elements and mediabunny rely on. */
export function serveFile({
	request,
	absolutePath,
	contentType,
	onClose,
}: {
	request: Request;
	absolutePath: string;
	contentType: string;
	onClose?: () => void;
}): Response {
	const file = Bun.file(absolutePath);
	const size = file.size;
	const headers = new Headers({
		"accept-ranges": "bytes",
		"content-type": contentType,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"last-modified": new Date(file.lastModified).toUTCString(),
	});
	function respond(status: number, blob: Blob | null): Response {
		if (!onClose) return new Response(blob, { status, headers });
		if (!blob) {
			onClose();
			return new Response(null, { status, headers });
		}

		// Keep a cached render leased until Bun finishes or cancels the body.
		const reader = blob.stream().getReader();
		let remaining = blob.size;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (!done) {
						controller.enqueue(value);
						remaining -= value.byteLength;
					}
					if (done || remaining === 0) {
						await reader.cancel();
						onClose();
						controller.close();
					}
				} catch (error) {
					onClose();
					throw error;
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					onClose();
				}
			},
		});
		return new Response(body, { status, headers });
	}

	const range = request.headers.get("range");
	const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
	if (range && !match) {
		headers.set("content-range", `bytes */${size}`);
		return respond(416, null);
	}
	if (match) {
		const [, startText, endText] = match;
		let start: number;
		let end: number;
		if (startText === "") {
			// Suffix range: the last N bytes.
			const length = Number(endText);
			start = Math.max(0, size - length);
			end = size - 1;
		} else {
			start = Number(startText);
			end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
		}
		if (!Number.isFinite(start) || start > end || start >= size) {
			headers.set("content-range", `bytes */${size}`);
			return respond(416, null);
		}
		headers.set("content-range", `bytes ${start}-${end}/${size}`);
		headers.set("content-length", String(end - start + 1));
		return respond(206, request.method === "HEAD" ? null : file.slice(start, end + 1));
	}
	headers.set("content-length", String(size));
	return respond(200, request.method === "HEAD" ? null : file);
}
