import { RPC_ERRORS } from "@splice/bridge";
import {
	type BeginExportRequest,
	beginExportRequestSchema,
	EXPORT_FILE_KINDS,
	type ExportFileKind,
	type ExportRecord,
	type ExportSource,
	exportIdRequestSchema,
	exportRecordSchema,
	exportsFileSchema,
	exportsListRequestSchema,
} from "@splice/bridge/delivery";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { startDetached } from "./background";
import { BridgeError } from "./tab-bridge";
import { invalidParams } from "./transcription";

export const EXPORTS_FOLDER = "Exports";
/** The most an export file chunk may hold; Bun refuses bodies over 128 MB. */
export const MAX_EXPORT_CHUNK_BYTES = 64 * 1024 * 1024;
/** Where an export's files wait until both are written. */
const STAGING_FOLDER = ".staging";
/** Each published pair's record, next to its files. */
const RECORD_FILE = "export.json";
const LEGACY_HISTORY_FILE = "exports.json";
const MAX_STEM_LENGTH = 80;

/** Opens a folder in the platform's file manager. */
export type OpenFolder = (folder: string) => Promise<void>;

const openFolderWithDesktop: OpenFolder = (folder) =>
	startDetached({
		command:
			process.platform === "win32"
				? "explorer.exe"
				: process.platform === "darwin"
					? "open"
					: "xdg-open",
		args: [folder],
	});

/** A file name stem that is valid on Windows, from the project name and time. */
export function exportStem({
	projectName,
	at,
}: {
	projectName: string;
	at: Date;
}): string {
	const name =
		projectName
			// Characters Windows forbids in file names, and control characters.
			.replace(/[<>:"/\\|?*\p{Cc}]/gu, " ")
			.replace(/\s+/g, " ")
			.replace(/^[. ]+/, "")
			.slice(0, MAX_STEM_LENGTH)
			// Windows drops trailing dots and spaces.
			.replace(/[. ]+$/, "") || "Export";
	const pad = (value: number) => String(value).padStart(2, "0");
	const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
	const time = `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
	return `${name} ${date} ${time}`;
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

interface PendingExport {
	source: BeginExportRequest;
	dir: string;
	written: Map<ExportFileKind, number>;
	publishing: boolean;
}

/** A published pair and where its files are, relative to Exports. */
interface PublishedExport {
	record: ExportRecord;
	files: Record<ExportFileKind, string>;
}

/**
 * Publishes MP4/SRT pairs under Exports. The tab writes both files into a
 * staging folder of their own; once both are there, the folder gets their
 * record and moves into Exports as `<stem>` in one rename, so a pair is
 * published whole, with its record, or not at all.
 */
export function createExportStore({
	root,
	openFolder = openFolderWithDesktop,
	now = () => new Date(),
}: {
	root: string;
	openFolder?: OpenFolder;
	now?: () => Date;
}) {
	const folder = join(root, EXPORTS_FOLDER);
	const staging = join(folder, STAGING_FOLDER);
	const pending = new Map<string, PendingExport>();
	// Staging cleanup, reservation and publishing share the same queue.
	let stagingQueue: Promise<unknown> = Promise.resolve();
	function withStaging<T>(operation: () => Promise<T>): Promise<T> {
		const run = stagingQueue.then(operation);
		stagingQueue = run.catch(() => {});
		return run;
	}

	/** Pairs published before per-export folders, from `exports.json`. */
	async function readLegacyHistory(): Promise<PublishedExport[]> {
		const path = join(folder, LEGACY_HISTORY_FILE);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			return [];
		}
		const parsed = exportsFileSchema.safeParse(JSON.parse(text));
		if (!parsed.success)
			throw new BridgeError({
				code: RPC_ERRORS.INTERNAL,
				message: `${path} is not a valid export history. Move it aside to start a new one.`,
			});
		return parsed.data.exports.map((record) => ({
			record,
			files: { mp4: `${record.stem}.mp4`, srt: `${record.stem}.srt` },
		}));
	}

	/** Every published pair, oldest first. */
	async function readPublished(): Promise<PublishedExport[]> {
		let entries: Dirent[];
		try {
			entries = await readdir(folder, { withFileTypes: true });
		} catch {
			return [];
		}
		const published = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && entry.name !== STAGING_FOLDER)
				.map(async ({ name }): Promise<PublishedExport | null> => {
					let text: string;
					try {
						text = await readFile(join(folder, name, RECORD_FILE), "utf8");
					} catch {
						// A folder the creator made, not an export.
						return null;
					}
					let json: unknown;
					try {
						json = JSON.parse(text);
					} catch {
						return null;
					}
					const parsed = exportRecordSchema.safeParse(json);
					if (!parsed.success) return null;
					const { stem } = parsed.data;
					return {
						record: parsed.data,
						files: { mp4: `${name}/${stem}.mp4`, srt: `${name}/${stem}.srt` },
					};
				}),
		);
		return [
			...(await readLegacyHistory()),
			...published.filter((entry) => entry !== null),
		].sort(
			(a, b) =>
				a.record.exportedAt.localeCompare(b.record.exportedAt) ||
				a.record.stem.localeCompare(b.record.stem, undefined, { numeric: true }),
		);
	}

	async function committed(deliveryId: string): Promise<ExportRecord | null> {
		return (
			(await readPublished()).find(
				({ record }) => record.deliveryId === deliveryId,
			)?.record ?? null
		);
	}

	function pendingExport(params: unknown): [string, PendingExport] {
		const parsed = exportIdRequestSchema.safeParse(params);
		if (!parsed.success) throw invalidParams(parsed.error.message);
		const found = pending.get(parsed.data.exportId);
		if (!found || found.publishing)
			throw invalidParams(
				"That export was not started or has already finished. Start it again.",
			);
		return [parsed.data.exportId, found];
	}

	async function freeStem(source: ExportSource): Promise<string> {
		const base = exportStem({ projectName: source.projectName, at: now() });
		for (let attempt = 1; ; attempt++) {
			const stem = attempt === 1 ? base : `${base} (${attempt})`;
			if (
				!(await exists(join(folder, stem))) &&
				!(await exists(join(folder, `${stem}.mp4`))) &&
				!(await exists(join(folder, `${stem}.srt`)))
			)
				return stem;
		}
	}

	async function publish(entry: PendingExport): Promise<ExportRecord> {
		const { deliveryId, ...source } = entry.source;
		// An earlier attempt at this Export, whose answer was lost, published it.
		const earlier = await committed(deliveryId);
		if (earlier) return earlier;
		const stem = await freeStem(source);
		const record: ExportRecord = {
			...source,
			stem,
			deliveryId,
			exportedAt: now().toISOString(),
			bytes: {
				mp4: entry.written.get("mp4") ?? 0,
				srt: entry.written.get("srt") ?? 0,
			},
		};
		// Nothing outside staging changes until the folder moves in whole.
		for (const kind of EXPORT_FILE_KINDS)
			await rename(join(entry.dir, kind), join(entry.dir, `${stem}.${kind}`));
		await writeFile(
			join(entry.dir, RECORD_FILE),
			JSON.stringify(record, null, 2),
		);
		await rename(entry.dir, join(folder, stem));
		return record;
	}

	return {
		folder,

		/**
		 * Starts an export, or, when this Export click already published its
		 * pair, returns that pair as `committed` instead of starting another.
		 */
		async begin(
			params: unknown,
		): Promise<{ exportId: string } | { committed: ExportRecord }> {
			const parsed = beginExportRequestSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			return withStaging(async () => {
				const earlier = await committed(parsed.data.deliveryId);
				if (earlier) return { committed: earlier };
				// Staged files nothing waits for any more are temporary renders.
				if (pending.size === 0)
					await rm(staging, { recursive: true, force: true });
				const exportId = randomUUID();
				const dir = join(staging, exportId);
				await mkdir(dir, { recursive: true });
				pending.set(exportId, {
					source: parsed.data,
					dir,
					written: new Map(),
					publishing: false,
				});
				return { exportId };
			});
		},

		/**
		 * Writes one chunk of a file of the pair into staging. Chunks arrive in
		 * order; offset 0 starts the file again.
		 */
		async write({
			exportId,
			kind,
			offset,
			body,
		}: {
			exportId: string;
			kind: ExportFileKind;
			offset: number;
			body: ReadableStream<Uint8Array> | null;
		}) {
			const [, entry] = pendingExport({ exportId });
			const written = entry.written.get(kind) ?? 0;
			if (offset !== 0 && offset !== written)
				throw invalidParams(
					`The ${kind.toUpperCase()} continues at byte ${written}, not ${offset}.`,
				);
			const data = new Uint8Array(await new Response(body).arrayBuffer());
			const file = join(entry.dir, kind);
			if (offset === 0) await writeFile(file, data);
			else await appendFile(file, data);
			entry.written.set(kind, offset + data.length);
			return { bytes: offset + data.length };
		},

		async publish(params: unknown): Promise<ExportRecord> {
			const [id, entry] = pendingExport(params);
			for (const kind of EXPORT_FILE_KINDS)
				if (!entry.written.has(kind))
					throw invalidParams(`The ${kind.toUpperCase()} was not written yet.`);
			if (!entry.written.get("mp4")) throw invalidParams("The MP4 is empty.");
			// Publishing owns the staged files, including while it waits in the queue.
			entry.publishing = true;
			return withStaging(async () => {
				try {
					return await publish(entry);
				} finally {
					await rm(entry.dir, { recursive: true, force: true }).catch(() => {});
					pending.delete(id);
				}
			});
		},

		async abort(params: unknown) {
			const parsed = exportIdRequestSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const entry = pending.get(parsed.data.exportId);
			if (!entry || entry.publishing) return { aborted: false };
			pending.delete(parsed.data.exportId);
			await rm(entry.dir, { recursive: true, force: true });
			return { aborted: true };
		},

		/** Published pairs, newest first, with whether both files are still there. */
		async list(params: unknown) {
			const parsed = exportsListRequestSchema.safeParse(params ?? {});
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { projectId } = parsed.data;
			const published = (await readPublished())
				.filter(({ record }) => !projectId || record.projectId === projectId)
				.reverse();
			return {
				folder,
				exports: await Promise.all(
					published.map(async ({ record, files }) => ({
						...record,
						files,
						present:
							(await exists(join(folder, files.mp4))) &&
							(await exists(join(folder, files.srt))),
					})),
				),
			};
		},

		/** Opens the Exports folder, which holds every pair. */
		async open() {
			await mkdir(folder, { recursive: true });
			try {
				await openFolder(folder);
				return { opened: true, folder };
			} catch (error) {
				return {
					opened: false,
					folder,
					error: `Couldn't open a file manager: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async stop() {
			await stagingQueue;
		},
	};
}

export type ExportStore = ReturnType<typeof createExportStore>;
