import { type FootageFile, isFootagePath } from "@splice/bridge";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, realpath, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { fileIdentity } from "./file-identity";
import { createSharedWork } from "./shared-work";

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

const footageHashes = new Map<string, string>();
const MAX_CACHED_HASHES = 512;
const hashWork = createSharedWork<string>({
	stop: new AbortController().signal,
});
type HashProgress = (percentage: number) => void;
const progressListeners = new Map<string, Set<HashProgress>>();

/** Stream the full recording once per file version, sharing concurrent reads. */
export async function footageContentHash({
	absolutePath,
	version,
	signal,
	onProgress,
}: {
	absolutePath: string;
	version: string;
	signal?: AbortSignal;
	onProgress?: HashProgress;
}): Promise<string> {
	signal?.throwIfAborted();
	const cached = footageHashes.get(version);
	if (cached) {
		onProgress?.(100);
		return cached;
	}
	// An in-flight read must stat the same path it opened. Completed digests
	// can be reused across paths that identify the very same file version.
	const key = JSON.stringify([absolutePath, version]);
	const listeners = progressListeners.get(key) ?? new Set<HashProgress>();
	if (onProgress) {
		listeners.add(onProgress);
		progressListeners.set(key, listeners);
	}
	try {
		return await hashWork.run({
			key,
			signal,
			work: async (signal) => {
				const digest = await hashRecording({
					absolutePath,
					version,
					signal,
					report: (percent) => {
						for (const listener of progressListeners.get(key) ?? [])
							listener(percent);
					},
				});
				if (footageHashes.size >= MAX_CACHED_HASHES) {
					const oldest = footageHashes.keys().next();
					if (!oldest.done) footageHashes.delete(oldest.value);
				}
				footageHashes.set(version, digest);
				for (const report of progressListeners.get(key) ?? []) report(100);
				return digest;
			},
		});
	} finally {
		if (onProgress) {
			listeners.delete(onProgress);
			if (!listeners.size) progressListeners.delete(key);
		}
	}
}

async function hashRecording({
	absolutePath,
	version,
	signal,
	report,
}: {
	absolutePath: string;
	version: string;
	signal: AbortSignal;
	report: HashProgress;
}) {
	const changed = () =>
		new Error("Footage changed while reading its identity.");
	const file = await open(absolutePath, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || versionForStats(info) !== version) throw changed();
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(1024 * 1024);
		let read = 0;
		let reported = 0;
		while (read < info.size) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(chunk, 0, chunk.length, read);
			if (!bytesRead) throw changed();
			hash.update(chunk.subarray(0, bytesRead));
			read += bytesRead;
			const percent = Math.min(99, Math.floor((read / info.size) * 100));
			if (percent > reported) {
				reported = percent;
				report(percent);
			}
		}
		if (
			read !== info.size ||
			versionForStats(await file.stat()) !== version ||
			(await footageVersion({ absolutePath })) !== version
		)
			throw changed();
		signal.throwIfAborted();
		return hash.digest("hex");
	} finally {
		await file.close();
	}
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

/** Send progress separately from the file, so the editor can cancel a long probe. */
export function streamFootageIdentity({
	request,
	absolutePath,
	contentType,
	version,
}: {
	request: Request;
	absolutePath: string;
	contentType: string;
	version: string;
}): Response {
	const abort = new AbortController();
	const signal = AbortSignal.any([request.signal, abort.signal]);
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (message: object) => {
				if (!signal.aborted)
					controller.enqueue(encoder.encode(JSON.stringify(message) + "\n"));
			};
			void (async () => {
				try {
					const info = await stat(absolutePath);
					const contentHash = await footageContentHash({
						absolutePath,
						version,
						signal,
						onProgress: (progress) => send({ progress }),
					});
					if ((await footageVersion({ absolutePath })) !== version)
						throw new Error("Footage changed while reading its identity.");
					send({
						version,
						contentHash,
						contentType,
						size: info.size,
						// Match the resolution of the media response's Last-Modified header.
						lastModified: Math.floor(info.mtimeMs / 1000) * 1000,
					});
				} catch {
					send({
						error:
							"Could not verify the recording. Check the file and try again.",
					});
				} finally {
					if (!abort.signal.aborted) controller.close();
				}
			})();
		},
		cancel(reason) {
			abort.abort(reason);
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "application/x-ndjson",
			"cache-control": "no-store",
		},
	});
}
