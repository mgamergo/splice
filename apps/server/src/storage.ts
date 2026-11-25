import {
	STORAGE_CATEGORIES,
	storageCleanupSchema,
	storageSelectionSchema,
	type StorageCategory,
	type StorageReport,
} from "@splice/bridge/storage";
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { AnalysisCache, CacheUse } from "./cache-use";
import { fileIdentity } from "./file-identity";
import {
	removeStorageEntry,
	type StorageEntry as Entry,
} from "./storage-removal";
import { EXPORT_STAGING_FOLDER, type ExportStore } from "./exports";
import { invalidParams } from "./transcription";
import { ROOT_LOCK_FILE } from "./root-lock";

const PROTECTED_FOLDERS = new Map([
	[
		"Footage",
		"Original recordings and project items, including graphics and music",
	],
	["Projects", "Project data, approved checkpoints and corrected captions"],
	["Profile", "Editing profile, corrections and saved spellings"],
	["Exports", "Published exports and export history"],
	["Tools", "Installed tools and models"],
]);

type JobLayout = { name: RegExp; files: readonly string[] };

const ANALYSIS_FOLDERS = {
	transcripts: {
		jobs: [
			{
				name: /^\.job-[a-zA-Z0-9]{6}$/,
				files: ["audio.wav", "whisper.json", "transcript.json"],
			},
		],
	},
	pauses: {
		file: /^[0-9a-f]{64}\.json$/,
		jobs: [{ name: /^\.scan-[a-zA-Z0-9]{6}$/, files: ["scan.json"] }],
	},
	loudness: {
		file: /^(?:[0-9a-f]{64}\.json|audio-[0-9a-f]{64}\.mka)$/,
		jobs: [
			{ name: /^\.job-[a-zA-Z0-9]{6}$/, files: ["loudness.json"] },
			{ name: /^\.audio-[a-zA-Z0-9]{6}$/, files: ["audio.mka"] },
			{ name: /^\.ranges-[a-zA-Z0-9]{6}$/, files: ["ranges.ffconcat"] },
		],
	},
	"noise-reduction": {
		file: /^[0-9a-f]{64}\.wav$/,
		jobs: [{ name: /^\.job-[a-zA-Z0-9]{6}$/, files: ["denoised.wav"] }],
	},
} satisfies Record<
	AnalysisCache,
	{ file?: RegExp; jobs: readonly JobLayout[] }
>;

const EXPORT_JOB: JobLayout = {
	name: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	files: ["mp4", "srt"],
};

function isAnalysisCache(name: string): name is AnalysisCache {
	return Object.hasOwn(ANALYSIS_FOLDERS, name);
}

type Selection = ReturnType<typeof storageSelectionSchema.parse>;
type Cleanup = ReturnType<typeof storageCleanupSchema.parse>;
type Candidate = { category: StorageCategory; signature: string };
type Preview = {
	selection: Selection;
	candidates: Map<string, Candidate>;
};
const MAX_PREVIEWS = 16;

type Summary = { bytes: number; items: number };

function isWithin({
	parent,
	child,
}: {
	parent: string;
	child: string;
}): boolean {
	const path = relative(parent, child);
	return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function storageName(path: string): string {
	const name = basename(path);
	if (process.platform !== "win32") return name;
	const managed = ["Cache", ...PROTECTED_FOLDERS.keys()];
	return (
		managed.find((folder) => folder.toLowerCase() === name.toLowerCase()) ??
		name.toLowerCase()
	);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createStorage({
	root,
	cacheUse,
	exportStore,
}: {
	root: string;
	cacheUse: CacheUse;
	exportStore: Pick<ExportStore, "withStagingInventory">;
}) {
	let queue: Promise<unknown> = Promise.resolve();
	const previews = new Map<string, Preview>();

	async function inventory(options: Cleanup): Promise<StorageReport> {
		const { dryRun, previewToken, categories: requested } = options;
		const preview = previewToken && previews.get(previewToken);
		if (!dryRun && !preview)
			throw invalidParams(
				"Get a fresh storage preview before applying cleanup.",
			);
		if (dryRun && previewToken)
			throw invalidParams("Pass previewToken only when applying cleanup.");

		const selection = preview
			? preview.selection
			: {
					categories: requested,
					olderThanDays: options.olderThanDays,
				};
		const { categories, olderThanDays } = selection;
		if (
			preview &&
			options.olderThanDays !== undefined &&
			options.olderThanDays !== olderThanDays
		)
			throw invalidParams("Preview cleanup again to change the age threshold.");

		const candidates = new Map<string, Candidate>();
		let newOrChangedItems = 0;
		const canonicalRoot = await realpath(root);
		const rootInfo = await lstat(canonicalRoot);
		const managedRoot = { path: canonicalRoot, info: rootInfo };
		const errors: StorageReport["errors"] = [];
		const kept = new Map<string, StorageReport["kept"][number]>();
		const reclaimable = STORAGE_CATEGORIES.map((category) => ({
			category,
			bytes: 0,
			items: 0,
			freedBytes: 0,
		}));
		const cutoff =
			olderThanDays === undefined
				? Infinity
				: Date.now() - olderThanDays * 86_400_000;

		function issue({ path, message }: { path: string; message: string }) {
			errors.push({
				path: relative(canonicalRoot, path).split(sep).join("/"),
				message,
			});
		}

		async function children(path: string): Promise<Entry[]> {
			const names = await readdir(path).catch((error: unknown) => {
				if (!isMissing(error))
					issue({ path, message: "Couldn't read directory." });
				return [];
			});
			const entries: Entry[] = [];
			for (const name of names) {
				const child = join(path, name);
				try {
					entries.push({ path: child, info: await lstat(child) });
				} catch (error) {
					if (!isMissing(error))
						issue({ path: child, message: "Couldn't read file information." });
				}
			}
			return entries.sort((a, b) =>
				a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
			);
		}

		// A protected folder may be a link to a directory inside a cache.
		const protectedTargets: string[] = [];
		for (const folder of PROTECTED_FOLDERS.keys()) {
			try {
				const path = join(canonicalRoot, folder);
				if ((await lstat(path)).isSymbolicLink())
					protectedTargets.push(await realpath(path));
			} catch (error) {
				if (!isMissing(error))
					issue({
						path: join(canonicalRoot, folder),
						message: "Couldn't resolve the protected folder.",
					});
			}
		}

		async function summarize({ path, info }: Entry): Promise<Summary> {
			const total = {
				bytes: info.isFile() ? info.size : 0,
				items: info.isDirectory() ? 0 : 1,
			};
			if (!info.isDirectory() || info.dev !== rootInfo.dev) return total;
			for (const child of await children(path)) {
				const part = await summarize(child);
				total.bytes += part.bytes;
				total.items += part.items;
			}
			return total;
		}

		function keep({
			category,
			reason,
			bytes,
			items,
		}: StorageReport["kept"][number]) {
			const key = JSON.stringify([category, reason]);
			const row = kept.get(key) ?? { category, reason, bytes: 0, items: 0 };
			row.bytes += bytes;
			row.items += items;
			kept.set(key, row);
		}

		async function jobFiles({
			entry,
			layouts,
		}: {
			entry: Entry;
			layouts: readonly JobLayout[];
		}) {
			if (!entry.info.isDirectory() || entry.info.dev !== rootInfo.dev)
				return null;
			const layout = layouts.find(({ name }) =>
				name.test(basename(entry.path)),
			);
			if (!layout) return null;
			const before = errors.length;
			const files = await children(entry.path);
			// Empty folders and jobs with unfamiliar contents are kept.
			return files.length > 0 &&
				errors.length === before &&
				files.every(
					({ path, info }) =>
						info.isFile() && layout.files.includes(basename(path)),
				)
				? files
				: null;
		}

		function candidate({
			entry,
			ancestors,
			files,
			category,
			busy,
		}: {
			entry: Entry;
			ancestors: Entry[];
			files: Entry[];
			category: StorageCategory;
			busy: boolean;
		}) {
			const { path } = entry;
			const total = {
				bytes: 0,
				items: 0,
				newest: entry.info.mtimeMs,
				containsProtected: false,
			};
			for (const { info } of [entry, ...files]) {
				if (info.isFile()) {
					total.bytes += info.size;
					total.items++;
				}
				total.newest = Math.max(total.newest, info.mtimeMs);
				total.containsProtected ||=
					info.dev !== rootInfo.dev || (info.isFile() && info.nlink > 1);
			}
			const linked = protectedTargets.some(
				(target) =>
					isWithin({ parent: target, child: path }) ||
					isWithin({ parent: path, child: target }),
			);
			const reason = busy
				? "In use by a running job"
				: total.containsProtected || linked
					? "Contains protected, linked or unreadable data"
					: categories && !categories.includes(category)
						? "Category excluded"
						: total.newest > cutoff
							? "Newer than the age threshold"
							: null;
			if (reason) {
				keep({ category, reason, ...total });
				return;
			}

			const signature = JSON.stringify([
				ancestors.map(({ path, info }) => [path, info.dev, info.ino]),
				[entry, ...files].map(({ path, info }) => [
					path,
					info.dev,
					info.mode,
					info.nlink,
					...fileIdentity(info),
				]),
			]);
			if (preview) {
				const confirmed = preview.candidates.get(path);
				if (
					confirmed?.category !== category ||
					confirmed.signature !== signature
				) {
					newOrChangedItems++;
					keep({
						category,
						reason: "New or changed since preview. Review again to clean up.",
						...total,
					});
					return;
				}
				if (requested && !requested.includes(category)) {
					keep({ category, reason: "Category excluded", ...total });
					return;
				}
			} else {
				candidates.set(path, { category, signature });
			}

			const row = reclaimable.find((item) => item.category === category);
			if (!row) return;
			row.bytes += total.bytes;
			row.items++;
			if (dryRun) return;
			try {
				removeStorageEntry({
					ancestors,
					entry,
					files,
					onRemove: (bytes) => {
						row.freedBytes += bytes;
					},
				});
			} catch {
				issue({
					path,
					message:
						"Item changed or couldn't be safely removed. Refresh and try again.",
				});
			}
		}

		async function walkCache(entry: Entry) {
			for (const directory of await children(entry.path)) {
				const name = storageName(directory.path);
				if (
					!isAnalysisCache(name) ||
					!directory.info.isDirectory() ||
					directory.info.dev !== entry.info.dev
				) {
					const reason =
						name === "session.json" ||
						name === ROOT_LOCK_FILE ||
						name === `${ROOT_LOCK_FILE}-journal`
							? "Splice runtime state"
							: "Unrecognized cache data";
					keep({ category: "Cache", reason, ...(await summarize(directory)) });
					continue;
				}

				await cacheUse.inspect({
					cache: name,
					operation: async (busy) => {
						const { jobs } = ANALYSIS_FOLDERS[name];
						const ancestors = [managedRoot, entry, directory];
						for (const file of await children(directory.path)) {
							const files = await jobFiles({ entry: file, layouts: jobs });
							if (files) {
								candidate({
									entry: file,
									ancestors,
									files,
									category: "temporary-renders",
									busy,
								});
							} else if (
								name !== "transcripts" &&
								file.info.isFile() &&
								ANALYSIS_FOLDERS[name].file.test(basename(file.path))
							) {
								candidate({
									entry: file,
									ancestors,
									files: [],
									category: name,
									busy,
								});
							} else {
								const reason =
									name === "transcripts" && file.info.isFile()
										? "Word timings and identities used by captions and corrections"
										: "Unrecognized cache data";
								keep({ category: name, reason, ...(await summarize(file)) });
							}
						}
					},
				});
			}
		}

		for (const entry of await children(canonicalRoot)) {
			const name = storageName(entry.path);
			if (!entry.info.isDirectory() || entry.info.dev !== rootInfo.dev) {
				keep({
					category: name,
					reason: "Outside managed cleanup folders or linked",
					...(await summarize(entry)),
				});
			} else if (name === "Cache") {
				await walkCache(entry);
			} else if (name === "Exports") {
				await exportStore.withStagingInventory(async (isPending) => {
					const path = join(entry.path, EXPORT_STAGING_FOLDER);
					const info = await lstat(path).catch((error: unknown) => {
						if (!isMissing(error))
							issue({ path, message: "Couldn't read export staging." });
						return null;
					});
					if (!info) return;
					if (!info.isDirectory() || info.dev !== rootInfo.dev) {
						keep({
							category: name,
							reason: "Linked or outside managed cleanup folders",
							...(await summarize({ path, info })),
						});
						return;
					}
					const ancestors = [managedRoot, entry, { path, info }];
					for (const staged of await children(path)) {
						const files = await jobFiles({
							entry: staged,
							layouts: [EXPORT_JOB],
						});
						if (files) {
							candidate({
								entry: staged,
								ancestors,
								files,
								category: "export-staging",
								busy: isPending(basename(staged.path)),
							});
						} else {
							keep({
								category: "export-staging",
								reason: isPending(basename(staged.path))
									? "In use by a running job"
									: "Unrecognized export staging data",
								...(await summarize(staged)),
							});
						}
					}
				});
				for (const exported of await children(entry.path)) {
					if (storageName(exported.path) !== EXPORT_STAGING_FOLDER)
						keep({
							category: name,
							reason: PROTECTED_FOLDERS.get("Exports") ?? "Published exports",
							...(await summarize(exported)),
						});
				}
			} else {
				keep({
					category: name,
					reason:
						PROTECTED_FOLDERS.get(name) ?? "Outside managed cleanup folders",
					...(await summarize(entry)),
				});
			}
		}

		let nextToken: string | undefined;
		if (dryRun) {
			nextToken = randomUUID();
			previews.set(nextToken, { selection, candidates });
			const oldest = previews.keys().next().value;
			if (previews.size > MAX_PREVIEWS && oldest) previews.delete(oldest);
		}

		return {
			dryRun,
			previewToken: nextToken,
			newOrChangedItems,
			reclaimableBytes: reclaimable.reduce((sum, row) => sum + row.bytes, 0),
			freedBytes: reclaimable.reduce((sum, row) => sum + row.freedBytes, 0),
			categories: reclaimable,
			kept: [...kept.values()],
			errors,
		};
	}

	function run(options: ReturnType<typeof storageCleanupSchema.parse>) {
		const next = queue.then(async () => {
			try {
				return await inventory(options);
			} finally {
				if (!options.dryRun && options.previewToken)
					previews.delete(options.previewToken);
			}
		});
		queue = next.catch(() => {});
		return next;
	}

	return {
		async report(params: unknown) {
			const parsed = storageSelectionSchema.strict().safeParse(params ?? {});
			if (!parsed.success) throw invalidParams(parsed.error.message);
			return run({ ...parsed.data, dryRun: true });
		},
		async cleanup(params: unknown) {
			const parsed = storageCleanupSchema.strict().safeParse(params ?? {});
			if (!parsed.success) throw invalidParams(parsed.error.message);
			return run(parsed.data);
		},
		async stop() {
			await queue;
		},
	};
}
