import { RPC_ERRORS } from "@splice/bridge";
import {
	beginExportRequestSchema,
	type ExportFileKind,
	type ExportRecord,
	type ExportSource,
	exportIdRequestSchema,
	exportsFileSchema,
	exportsListRequestSchema,
} from "@splice/bridge/delivery";
import { randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
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
const HISTORY_FILE = "exports.json";
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
			.trim()
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
	source: ExportSource;
	dir: string;
	written: Map<ExportFileKind, number>;
}

/**
 * Publishes MP4/SRT pairs under Exports. The tab writes both files into a
 * staging folder; only once both are there do they move into Exports under
 * one new stem, so a failed export never replaces or half-writes a pair.
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
	const historyPath = join(folder, HISTORY_FILE);
	const pending = new Map<string, PendingExport>();
	// Publishing picks a free stem and rewrites the history, one at a time.
	let publishing: Promise<unknown> = Promise.resolve();

	async function readHistory(): Promise<ExportRecord[]> {
		let text: string;
		try {
			text = await readFile(historyPath, "utf8");
		} catch {
			return [];
		}
		const parsed = exportsFileSchema.safeParse(JSON.parse(text));
		if (!parsed.success)
			throw new BridgeError({
				code: RPC_ERRORS.INTERNAL,
				message: `${historyPath} is not a valid export history. Move it aside to start a new one.`,
			});
		return parsed.data.exports;
	}

	async function writeHistory(exports: ExportRecord[]): Promise<void> {
		const temporary = `${historyPath}.${randomUUID()}.tmp`;
		await Bun.write(temporary, JSON.stringify({ version: 1, exports }, null, 2));
		await rename(temporary, historyPath);
	}

	function pendingExport(params: unknown): [string, PendingExport] {
		const parsed = exportIdRequestSchema.safeParse(params);
		if (!parsed.success) throw invalidParams(parsed.error.message);
		const found = pending.get(parsed.data.exportId);
		if (!found)
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
				!(await exists(join(folder, `${stem}.mp4`))) &&
				!(await exists(join(folder, `${stem}.srt`)))
			)
				return stem;
		}
	}

	async function publish({ id, entry }: { id: string; entry: PendingExport }) {
		for (const kind of ["mp4", "srt"] as const)
			if (!entry.written.has(kind))
				throw invalidParams(`The ${kind.toUpperCase()} was not written yet.`);
		if (!entry.written.get("mp4"))
			throw invalidParams("The MP4 is empty.");
		const stem = await freeStem(entry.source);
		const video = join(folder, `${stem}.mp4`);
		const captions = join(folder, `${stem}.srt`);
		const record: ExportRecord = {
			...entry.source,
			stem,
			exportedAt: now().toISOString(),
			bytes: {
				mp4: entry.written.get("mp4") ?? 0,
				srt: entry.written.get("srt") ?? 0,
			},
		};
		const history = await readHistory();
		await rename(join(entry.dir, "mp4"), video);
		try {
			await rename(join(entry.dir, "srt"), captions);
			await writeHistory([...history, record]);
		} catch (error) {
			// Without both files and their record the pair isn't published.
			await Promise.all([unlink(video), unlink(captions)].map((p) => p.catch(() => {})));
			throw error;
		}
		pending.delete(id);
		await rm(entry.dir, { recursive: true, force: true });
		return record;
	}

	return {
		folder,

		async begin(params: unknown) {
			const parsed = beginExportRequestSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
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
			});
			return { exportId };
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

		publish(params: unknown): Promise<ExportRecord> {
			const [id, entry] = pendingExport(params);
			const run = publishing.then(() => publish({ id, entry }));
			publishing = run.catch(() => {});
			return run;
		},

		async abort(params: unknown) {
			const parsed = exportIdRequestSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const entry = pending.get(parsed.data.exportId);
			pending.delete(parsed.data.exportId);
			if (entry) await rm(entry.dir, { recursive: true, force: true });
			return { aborted: !!entry };
		},

		/** Published pairs, newest first, with whether both files are still there. */
		async list(params: unknown) {
			const parsed = exportsListRequestSchema.safeParse(params ?? {});
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { projectId } = parsed.data;
			const records = (await readHistory())
				.filter((record) => !projectId || record.projectId === projectId)
				.reverse();
			return {
				folder,
				exports: await Promise.all(
					records.map(async (record) => ({
						...record,
						files: {
							mp4: `${record.stem}.mp4`,
							srt: `${record.stem}.srt`,
						},
						present:
							(await exists(join(folder, `${record.stem}.mp4`))) &&
							(await exists(join(folder, `${record.stem}.srt`))),
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
			await publishing;
		},
	};
}

export type ExportStore = ReturnType<typeof createExportStore>;
