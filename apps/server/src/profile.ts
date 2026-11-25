import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type Correction,
	correctionSchema,
	profileApplySchema,
	profileCaptureSchema,
	profilePendingSchema,
} from "@splice/bridge/profile";
import { z } from "zod";
import { invalidParams } from "./transcription";

const EMPTY_PROFILE = `# Editing profile

No preferences have been learned yet.

## Take selection

## Tightening
`;

const updateSchema = z.strictObject({
	id: z.uuid(),
	timestamp: z.iso.datetime(),
	correctionIds: z.array(z.uuid()),
	previousText: z.string(),
	text: z.string(),
});

const transactionSchema = z.strictObject({
	kind: z.enum(["capture", "apply"]),
	offset: z.number().int().nonnegative(),
	// Preserve the exact bytes to append, even if a newer server replays the journal.
	lines: z.string(),
});
type Transaction = z.infer<typeof transactionSchema>;

function isMissing(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readIfPresent(path: string) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (!isMissing(error)) throw error;
		return undefined;
	}
}

async function sizeIfPresent(path: string) {
	try {
		return (await stat(path)).size;
	} catch (error) {
		if (!isMissing(error)) throw error;
		return 0;
	}
}

function parseRequest<T>(schema: z.ZodType<T>, params: unknown): T {
	const parsed = schema.safeParse(params);
	if (!parsed.success) throw invalidParams(parsed.error.message);
	return parsed.data;
}

function jsonLines(records: unknown[]) {
	return records.map((record) => JSON.stringify(record) + "\n").join("");
}

function parseCorrections(text: string): Correction[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => correctionSchema.parse(JSON.parse(line)));
}

async function readCorrections(path: string) {
	return parseCorrections((await readIfPresent(path)) ?? "");
}

function versionOf(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

/** The single writer for the editing profile under splice's data root. */
export function createProfileStore({ root }: { root: string }) {
	const directory = join(root, "Profile");
	const profilePath = join(directory, "profile.md");
	const correctionPath = join(directory, "corrections.jsonl");
	const pendingPath = join(directory, "pending.jsonl");
	const updatesPath = join(directory, "updates.jsonl");
	const journalPath = join(directory, "transaction.json");
	let work: Promise<unknown> = Promise.resolve();
	let knownIds: Set<string> | undefined;

	async function syncDirectory() {
		// Windows does not allow opening a directory for fsync.
		if (process.platform === "win32") return;
		const handle = await open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async function replace(path: string, text: string) {
		const temporary = `${path}.tmp`;
		const handle = await open(temporary, "w");
		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		await syncDirectory();
	}

	/** Replays an append at its original byte offset, including a partial write. */
	async function append(path: string, offset: number, text: string) {
		const bytes = Buffer.from(text);
		const handle = await open(path, "a+");
		try {
			const size = (await handle.stat()).size;
			if (size < offset)
				throw new Error(`${path} changed during a Profile update.`);
			const length = Math.min(size - offset, bytes.length);
			if (length) {
				const existing = Buffer.alloc(length);
				const { bytesRead } = await handle.read(existing, 0, length, offset);
				if (bytesRead !== length || !existing.equals(bytes.subarray(0, length)))
					throw new Error(`${path} changed during a Profile update.`);
			}
			if (length < bytes.length) await handle.writeFile(bytes.subarray(length));
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async function finish(transaction: Transaction) {
		const pending = await readCorrections(pendingPath);
		if (transaction.kind === "capture") {
			const { offset, lines } = transaction;
			const corrections = parseCorrections(lines);
			await append(correctionPath, offset, lines);
			const pendingIds = new Set(pending.map(({ id }) => id));
			await replace(
				pendingPath,
				jsonLines([
					...pending,
					...corrections.filter(({ id }) => !pendingIds.has(id)),
				]),
			);
			for (const { id } of corrections) knownIds?.add(id);
		} else {
			const { offset, lines } = transaction;
			const update = updateSchema.parse(JSON.parse(lines));
			await append(updatesPath, offset, lines);
			await replace(profilePath, update.text);
			const applied = new Set(update.correctionIds);
			await replace(
				pendingPath,
				jsonLines(pending.filter(({ id }) => !applied.has(id))),
			);
		}
		await rm(journalPath);
		await syncDirectory();
	}

	function serialized<T>(run: () => Promise<T>) {
		const result = work.then(async () => {
			await mkdir(directory, { recursive: true });
			const journal = await readIfPresent(journalPath);
			if (journal !== undefined)
				await finish(transactionSchema.parse(JSON.parse(journal)));
			return run();
		});
		work = result.catch(() => {});
		return result;
	}

	async function commit(transaction: Transaction) {
		await replace(journalPath, JSON.stringify(transaction));
		await finish(transaction);
	}

	async function readProfile() {
		const existing = await readIfPresent(profilePath);
		if (existing !== undefined) return existing;
		await replace(profilePath, EMPTY_PROFILE);
		return EMPTY_PROFILE;
	}

	return {
		initialize: () => serialized(readProfile),
		stop: () => work,
		read: () =>
			serialized(async () => {
				const text = await readProfile();
				return { text, version: versionOf(text) };
			}),
		async capture(params: unknown) {
			const { corrections } = parseRequest(profileCaptureSchema, params);
			return serialized(async () => {
				const ids = (knownIds ??= new Set(
					(await readCorrections(correctionPath)).map(({ id }) => id),
				));
				const fresh = [
					...new Map(
						corrections.map((correction) => [correction.id, correction]),
					).values(),
				].filter(({ id }) => !ids.has(id));
				if (fresh.length) {
					await commit({
						kind: "capture",
						offset: await sizeIfPresent(correctionPath),
						lines: jsonLines(fresh),
					});
				}
				return { recorded: fresh.length };
			});
		},
		async pending(params: unknown) {
			const { after, limit } = parseRequest(profilePendingSchema, params ?? {});
			return serialized(async () => {
				const pending = await readCorrections(pendingPath);
				const index = after ? pending.findIndex(({ id }) => id === after) : -1;
				if (after && index === -1)
					throw invalidParams(
						"That cursor is no longer pending. Start again from the first page.",
					);
				const corrections = pending.slice(index + 1, index + 1 + limit);
				return {
					corrections,
					nextCursor:
						index + 1 + limit < pending.length
							? (corrections.at(-1)?.id ?? null)
							: null,
				};
			});
		},
		async apply(params: unknown) {
			const { text, correctionIds, expectedVersion } = parseRequest(
				profileApplySchema,
				params,
			);
			return serialized(async () => {
				const previousText = await readProfile();
				if (
					expectedVersion !== undefined &&
					expectedVersion !== versionOf(previousText)
				)
					throw invalidParams(
						"The editing profile changed. Read it again before applying an update.",
					);
				const pending = new Set(
					(await readCorrections(pendingPath)).map(({ id }) => id),
				);
				const ids = [...new Set(correctionIds)];
				if (ids.some((id) => !pending.has(id)))
					throw invalidParams("Every correction ID must still be pending.");
				const update = {
					id: randomUUID(),
					timestamp: new Date().toISOString(),
					correctionIds: ids,
					previousText,
					text,
				};
				await commit({
					kind: "apply",
					offset: await sizeIfPresent(updatesPath),
					lines: jsonLines([update]),
				});
				return {
					updateId: update.id,
					applied: ids.length,
					version: versionOf(text),
				};
			});
		},
	};
}
