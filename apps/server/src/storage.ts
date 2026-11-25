import {
	STORAGE_CATEGORIES,
	storageCleanupSchema,
	storageSelectionSchema,
	type StorageCategory,
	type StorageReport,
} from "@splice/bridge/storage";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AnalysisCache, CacheUse } from "./cache-use";
import { sameFileIdentity } from "./file-identity";
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

const ANALYSIS_FOLDERS = {
	transcripts: { temporary: /^\.job-.+$/ },
	pauses: { file: /^[0-9a-f]{64}\.json$/, temporary: /^\.scan-.+$/ },
	loudness: {
		file: /^(?:[0-9a-f]{64}\.json|audio-[0-9a-f]{64}\.mka)$/,
		temporary: /^\.(?:job|audio|ranges)-.+$/,
	},
	"noise-reduction": { file: /^[0-9a-f]{64}\.wav$/, temporary: /^\.job-.+$/ },
} satisfies Record<AnalysisCache, { file?: RegExp; temporary: RegExp }>;

function isAnalysisCache(name: string): name is AnalysisCache {
	return Object.hasOwn(ANALYSIS_FOLDERS, name);
}

const CLEANUP_FOLDER = /^\.cleanup-[0-9a-f-]{36}$/;

type Entry = { path: string; info: Stats };
type Summary = {
	bytes: number;
	items: number;
	newest: number;
	containsProtected: boolean;
};

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

	async function inventory({
		dryRun,
		categories,
		olderThanDays,
	}: ReturnType<typeof storageCleanupSchema.parse>): Promise<StorageReport> {
		const canonicalRoot = await realpath(root);
		const rootInfo = await lstat(canonicalRoot);
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
			return entries;
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
			const containsProtected =
				info.dev !== rootInfo.dev ||
				(info.isFile() ? info.nlink > 1 : !info.isDirectory());
			const total: Summary = {
				bytes: info.isFile() ? info.size : 0,
				items: info.isDirectory() ? 0 : 1,
				newest: info.mtimeMs,
				containsProtected,
			};
			if (!info.isDirectory() || containsProtected) return total;
			const before = errors.length;
			for (const child of await children(path)) {
				const part = await summarize(child);
				total.bytes += part.bytes;
				total.items += part.items;
				total.newest = Math.max(total.newest, part.newest);
				total.containsProtected ||= part.containsProtected;
			}
			total.containsProtected ||= errors.length !== before;
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

		async function candidate({
			entry,
			category,
			busy,
		}: {
			entry: Entry;
			category: StorageCategory;
			busy: boolean;
		}) {
			const { path, info } = entry;
			const total = await summarize(entry);
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

			const row = reclaimable.find((item) => item.category === category);
			if (!row) return;
			row.bytes += total.bytes;
			row.items++;
			if (dryRun) return;
			try {
				if (
					relative(path, await realpath(path)) ||
					!sameFileIdentity({ a: info, b: await lstat(path) })
				) {
					issue({
						path,
						message: "Item changed during cleanup. Refresh and try again.",
					});
					return;
				}
				if (info.isDirectory()) {
					// Remove the whole job from its namespace before deleting its contents.
					const detached = join(dirname(path), `.cleanup-${randomUUID()}`);
					await rename(path, detached);
					try {
						await rm(detached, { recursive: true });
					} catch (error) {
						const before = errors.length;
						const remaining = await summarize({
							path: detached,
							info: await lstat(detached),
						});
						if (errors.length === before)
							row.freedBytes += Math.max(0, total.bytes - remaining.bytes);
						throw error;
					}
				} else {
					await unlink(path);
				}
				row.freedBytes += total.bytes;
			} catch (error) {
				if (isMissing(error)) return;
				issue({
					path,
					message: "Couldn't remove item. A later cleanup can retry.",
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
						const { temporary } = ANALYSIS_FOLDERS[name];
						for (const file of await children(directory.path)) {
							const leaf = basename(file.path);
							if (
								file.info.isDirectory() &&
								(temporary.test(leaf) || CLEANUP_FOLDER.test(leaf))
							) {
								await candidate({
									entry: file,
									category: "temporary-renders",
									busy,
								});
							} else if (
								name !== "transcripts" &&
								ANALYSIS_FOLDERS[name].file.test(leaf)
							) {
								await candidate({
									entry: file,
									category: name,
									busy,
								});
							} else {
								const reason =
									name === "transcripts"
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
					for (const staged of await children(path)) {
						await candidate({
							entry: staged,
							category: "export-staging",
							busy: isPending(basename(staged.path)),
						});
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

		return {
			dryRun,
			reclaimableBytes: reclaimable.reduce((sum, row) => sum + row.bytes, 0),
			freedBytes: reclaimable.reduce((sum, row) => sum + row.freedBytes, 0),
			categories: reclaimable,
			kept: [...kept.values()],
			errors,
		};
	}

	function run(options: ReturnType<typeof storageCleanupSchema.parse>) {
		const next = queue.then(() => inventory(options));
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
