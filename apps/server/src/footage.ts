import { type FootageFile, isFootagePath } from "@splice/bridge";
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { open, realpath, readdir, stat } from "node:fs/promises";
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
export function versionForStats(info: Stats): string {
	return createHash("sha256")
		.update([info.dev, ...fileIdentity(info)].join())
		.digest("hex");
}

export async function footageVersion({
	absolutePath,
}: {
	absolutePath: string;
}): Promise<string> {
	const info = await stat(absolutePath);
	if (!info.isFile()) throw new Error("Footage is unavailable.");
	return versionForStats(info);
}

const footageHashes = new Map<string, Promise<string>>();
const MAX_CACHED_HASHES = 512;

const SAMPLE_BYTES = 64 * 1024;
const SAMPLE_COUNT = 32;

/** Read at most 2 MiB, including both ends. Small files are read in full. */
async function sampleFootage({
	absolutePath,
	version,
}: {
	absolutePath: string;
	version: string;
}) {
	const file = await open(absolutePath, "r");
	try {
		const info = await file.stat();
		if (versionForStats(info) !== version)
			throw new Error("Footage changed while reading its identity.");
		const hash = createHash("sha256").update(String(info.size) + "\n");
		const buffer = Buffer.alloc(Math.min(info.size, SAMPLE_BYTES));
		const last = Math.max(0, info.size - SAMPLE_BYTES);
		const count = Math.min(SAMPLE_COUNT, Math.ceil(info.size / SAMPLE_BYTES));
		for (let index = 0; index < count; index++) {
			const offset = count === 1 ? 0 : Math.floor((last * index) / (count - 1));
			let read = 0;
			while (read < buffer.length) {
				const { bytesRead } = await file.read(
					buffer,
					read,
					buffer.length - read,
					offset + read,
				);
				if (!bytesRead)
					throw new Error("Footage ended while reading its identity.");
				read += bytesRead;
			}
			hash.update(buffer);
		}
		return "sample-v1:" + hash.digest("hex");
	} finally {
		await file.close();
	}
}

/** Share probes of a file version. Full hashes support existing approved cuts. */
export function footageContentHash({
	absolutePath,
	version,
	full = false,
}: {
	absolutePath: string;
	version: string;
	full?: boolean;
}): Promise<string> {
	const key = full ? "full:" + version : version;
	const cached = footageHashes.get(key);
	if (cached) return cached;
	const pending = (async () => {
		let fingerprint: string;
		if (full) {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(absolutePath))
				hash.update(chunk);
			fingerprint = hash.digest("hex");
		} else {
			fingerprint = await sampleFootage({ absolutePath, version });
		}
		if ((await footageVersion({ absolutePath })) !== version)
			throw new Error("Footage changed while reading its identity.");
		return fingerprint;
	})().catch((error: unknown) => {
		if (footageHashes.get(key) === pending) footageHashes.delete(key);
		throw error;
	});
	if (footageHashes.size >= MAX_CACHED_HASHES) {
		const oldest = footageHashes.keys().next();
		if (!oldest.done) footageHashes.delete(oldest.value);
	}
	footageHashes.set(key, pending);
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
	function respond({
		status,
		blob,
	}: {
		status: number;
		blob: Blob | null;
	}): Response {
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
		return respond({ status: 416, blob: null });
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
			return respond({ status: 416, blob: null });
		}
		headers.set("content-range", `bytes ${start}-${end}/${size}`);
		headers.set("content-length", String(end - start + 1));
		return respond({
			status: 206,
			blob: request.method === "HEAD" ? null : file.slice(start, end + 1),
		});
	}
	headers.set("content-length", String(size));
	return respond({
		status: 200,
		blob: request.method === "HEAD" ? null : file,
	});
}
