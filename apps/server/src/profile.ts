import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type CorrectionEvent,
	correctionEventSchema,
	correctionSchema,
	profileApplySchema,
	profileCaptureSchema,
	profilePendingSchema,
	profileQuestionSchema,
	profileQuestionResponseSchema,
} from "@splice/bridge/profile";
import { z } from "zod";
import { invalidParams } from "./transcription";

import {
	changeKind,
	changeSchema,
	EMPTY_PROFILE,
	entrySchema,
	manualEntries,
	type Preference,
	preferenceChanges,
	type ProfileEntry,
	renderProfile,
	validateAnalysis,
} from "./profile-preferences";

const questionResponseSchema = z.strictObject({
	question: profileQuestionSchema,
	answer: z.string().nullable(),
});

const revertSchema = z.strictObject({
	id: z.uuid(),
	operationId: z.uuid(),
	confirmConflicts: z.array(z.uuid()).optional(),
});

const updateSchema = z.strictObject({
	id: z.uuid(),
	timestamp: z.iso.datetime(),
	correctionIds: z.array(z.uuid()),
	previousText: z.string(),
	answerIds: z.array(z.uuid()).optional(),
	question: profileQuestionSchema.optional(),
	reverts: z.uuid().optional(),
	text: z.string(),
	entries: z.array(entrySchema).optional(),
	changes: z.array(changeSchema).optional(),
	confirmedConflicts: z.array(z.uuid()).optional(),
	operation: z
		.strictObject({ id: z.uuid(), requestHash: z.string() })
		.optional(),
});

type Update = z.infer<typeof updateSchema>;

function changesFor(update: Update) {
	return (
		update.changes ??
		preferenceChanges({
			before: manualEntries(update.previousText),
			after: manualEntries(update.text),
		})
	);
}

function entriesFor(text: string, latest: Update | undefined) {
	return latest?.text === text && latest.entries
		? latest.entries
		: manualEntries(text);
}

function revertHistory(updates: Update[]) {
	const indices = new Map(updates.map(({ id }, index) => [id, index]));
	const reverted = new Map<string, number>();
	for (const [index, update] of updates.entries()) {
		if (update.reverts) reverted.set(update.reverts, index);
	}
	const lastWrites = new Map<ReturnType<typeof changeKind>, number>();
	const activeWrites = new Map<ReturnType<typeof changeKind>, number>();
	const changes = updates.map((update, index) => {
		const changes = changesFor(update);
		for (const change of changes) {
			const kind = changeKind(change);
			lastWrites.set(kind, index);
			if (!update.reverts && !reverted.has(update.id))
				activeWrites.set(kind, index);
		}
		return changes;
	});

	function conflictsAt(index: number) {
		const conflicts = new Set<number>();
		for (const change of changes[index] ?? []) {
			const later = activeWrites.get(changeKind(change));
			if (later !== undefined && later > index) conflicts.add(later);
		}
		return [...conflicts]
			.sort((a, b) => a - b)
			.map((later) => updates[later].id);
	}

	function inverseAt(index: number, entries: ProfileEntry[]) {
		const next = new Map(entries.map((entry) => [entry.kind, entry]));
		for (const change of changes[index] ?? []) {
			const kind = changeKind(change);
			if (!kind) continue;
			const lastWriter = lastWrites.get(kind) ?? index;
			const undone = updates[lastWriter]?.reverts;
			// A confirmed revert of an older update already replaced this value.
			if (
				undone &&
				(indices.get(undone) ?? index) < index &&
				lastWriter > index
			)
				continue;
			let before = change.before;
			// If an earlier writer has since been reverted, walk back through its
			// input too. A later revert must not resurrect an already undone value.
			for (let prior = index - 1; prior >= 0; prior--) {
				const earlier = changes[prior]?.find(
					(entry) => changeKind(entry) === kind,
				);
				if (!earlier) continue;
				if (
					(reverted.get(updates[prior].id) ?? -1) <= index ||
					JSON.stringify(earlier.after) !== JSON.stringify(before)
				)
					break;
				before = earlier.before;
			}
			if (before) next.set(kind, before);
			else next.delete(kind);
		}
		return [...next.values()];
	}

	return {
		canRevert: (update: Update, index: number) =>
			!update.reverts && !reverted.has(update.id) && !!changes[index]?.length,
		conflictsAt,
		inverseAt,
	};
}

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

function parseRequest<T>({
	schema,
	params,
}: {
	schema: z.ZodType<T>;
	params: unknown;
}): T {
	const parsed = schema.safeParse(params);
	if (!parsed.success) throw invalidParams(parsed.error.message);
	return parsed.data;
}

function jsonLines(records: unknown[]) {
	return records.map((record) => JSON.stringify(record) + "\n").join("");
}

function parseLines<T>({
	text,
	schema,
}: {
	text: string;
	schema: z.ZodType<T>;
}): T[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => schema.parse(JSON.parse(line)));
}

async function readCorrections(path: string) {
	return parseLines({
		text: (await readIfPresent(path)) ?? "",
		schema: correctionSchema,
	});
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
	const responsesPath = join(directory, "question-responses.json");
	const journalPath = join(directory, "transaction.json");
	let work: Promise<unknown> = Promise.resolve();
	let analysisWork: Promise<unknown> = Promise.resolve();
	let correctionLog: Map<string, CorrectionEvent> | undefined;

	async function readCorrectionLog() {
		return (correctionLog ??= new Map(
			parseLines({
				text: (await readIfPresent(correctionPath)) ?? "",
				schema: correctionEventSchema,
			}).map((event) => [event.id, event]),
		));
	}

	async function readUpdates() {
		return parseLines({
			text: (await readIfPresent(updatesPath)) ?? "",
			schema: updateSchema,
		});
	}

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

	async function replace({ path, text }: { path: string; text: string }) {
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
	async function append({
		path,
		offset,
		text,
	}: {
		path: string;
		offset: number;
		text: string;
	}) {
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
			const events = parseLines({ text: lines, schema: correctionEventSchema });
			await append({ path: correctionPath, offset, text: lines });
			const log = await readCorrectionLog();
			const remaining = new Map(
				pending.map((correction) => [correction.id, correction]),
			);
			const applied = new Set(
				events.some(({ kind }) => kind === "reactivate")
					? (await readUpdates()).flatMap(({ correctionIds }) => correctionIds)
					: [],
			);
			for (const event of events) {
				log.set(event.id, event);
				if ("correctionId" in event) {
					const original = log.get(event.correctionId);
					if (
						!original ||
						"correctionId" in original ||
						original.projectId !== event.projectId ||
						original.sequenceId !== event.sequenceId
					)
						continue;
					remaining.delete(original.id);
					if (event.kind === "reactivate" && !applied.has(original.id))
						remaining.set(original.id, original);
				} else {
					// Moving fresh entries to the end also preserves order on journal replay.
					remaining.delete(event.id);
					remaining.set(event.id, event);
				}
			}
			await replace({
				path: pendingPath,
				text: jsonLines([...remaining.values()]),
			});
		} else {
			const { offset, lines } = transaction;
			const update = updateSchema.parse(JSON.parse(lines));
			await append({ path: updatesPath, offset, text: lines });
			await replace({ path: profilePath, text: update.text });
			const applied = new Set(update.correctionIds);
			await replace({
				path: pendingPath,
				text: jsonLines(pending.filter(({ id }) => !applied.has(id))),
			});
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
		await replace({ path: journalPath, text: JSON.stringify(transaction) });
		await finish(transaction);
	}

	async function readProfile() {
		const existing = await readIfPresent(profilePath);
		if (existing !== undefined) return existing;
		await replace({ path: profilePath, text: EMPTY_PROFILE });
		return EMPTY_PROFILE;
	}

	// Keep MCP apply and agent analysis exclusive without blocking capture or reads
	// while the provider is thinking.
	function profileChange<T>(run: () => Promise<T>) {
		const result = analysisWork.then(run);
		analysisWork = result.catch(() => {});
		return result;
	}

	async function readResponses() {
		const text = await readIfPresent(responsesPath);
		return text === undefined
			? []
			: z.array(questionResponseSchema).parse(JSON.parse(text));
	}

	function activeQuestion({
		updates,
		responses,
	}: {
		updates: Awaited<ReturnType<typeof readUpdates>>;
		responses: Awaited<ReturnType<typeof readResponses>>;
	}) {
		const closed = new Set(responses.map(({ question }) => question.id));
		const reverted = new Set(
			updates.flatMap(({ reverts }) => (reverts ? [reverts] : [])),
		);
		for (const { id, question } of updates) {
			if (question && !closed.has(question.id) && !reverted.has(id))
				return question;
		}
		return null;
	}

	async function apply({
		text,
		correctionIds,
		expectedVersion,
		operationId,
		answerIds,
		question,
		reverts,
		entries,
		confirmedConflicts,
		signal,
	}: z.infer<typeof profileApplySchema> &
		Pick<
			z.infer<typeof updateSchema>,
			"answerIds" | "question" | "reverts" | "entries" | "confirmedConflicts"
		> & {
			signal?: AbortSignal;
		}) {
		const requestHash = versionOf(
			JSON.stringify({
				text,
				correctionIds,
				expectedVersion,
				answerIds,
				question,
				reverts,
				entries,
				confirmedConflicts,
			}),
		);
		const updates = await readUpdates();
		const previous = updates.find(
			({ operation }) => operation?.id === operationId,
		);
		if (previous) {
			if (previous.operation?.requestHash !== requestHash)
				throw invalidParams(
					"This operation ID was already used with different arguments.",
				);
			return applyResult(previous);
		}
		const previousText = await readProfile();
		if (expectedVersion !== versionOf(previousText))
			throw invalidParams(
				"The editing profile changed. Read it again before applying an update.",
			);
		const pending = new Set(
			(await readCorrections(pendingPath)).map(({ id }) => id),
		);
		const ids = [...new Set(correctionIds)];
		if (ids.some((id) => !pending.has(id)))
			throw invalidParams("Every correction ID must still be pending.");
		const before = entriesFor(previousText, updates.at(-1));
		const after =
			entries ?? (text === previousText ? before : manualEntries(text));
		const update = {
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			correctionIds: ids,
			previousText,
			text,
			answerIds,
			question,
			reverts,
			entries: after,
			changes: preferenceChanges({ before, after }),
			confirmedConflicts,
			operation: { id: operationId, requestHash },
		};
		const offset = await sizeIfPresent(updatesPath);
		signal?.throwIfAborted();
		await commit({
			kind: "apply",
			offset,
			lines: jsonLines([update]),
		});
		return applyResult(update);
	}

	return {
		initialize: () => serialized(readProfile),
		stop: async () => {
			await analysisWork;
			await work;
		},
		read: () =>
			serialized(async () => {
				const text = await readProfile();
				return { text, version: versionOf(text) };
			}),
		async capture(params: unknown) {
			const request = parseRequest({
				schema: profileCaptureSchema,
				params,
			});
			return serialized(async () => {
				const events =
					"events" in request ? request.events : request.corrections;
				const log = await readCorrectionLog();
				const fresh = [
					...new Map(events.map((event) => [event.id, event])).values(),
				].filter(({ id }) => !log.has(id));
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
			const { after, limit } = parseRequest({
				schema: profilePendingSchema,
				params: params ?? {},
			});
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
			const request = parseRequest({ schema: profileApplySchema, params });
			return profileChange(() => serialized(() => apply(request)));
		},
		panel: () =>
			serialized(async () => {
				const text = await readProfile();
				const updates = await readUpdates();
				const history = revertHistory(updates);
				const current = updates.at(-1)?.text === text;
				return {
					text,
					updates: updates
						.map((update, index) => {
							const canRevert = current && history.canRevert(update, index);
							return {
								id: update.id,
								timestamp: update.timestamp,
								correctionCount: update.correctionIds.length,
								answerCount: update.answerIds?.length ?? 0,
								reverts: update.reverts,
								canRevert,
								conflicts: canRevert ? history.conflictsAt(index) : [],
							};
						})
						.reverse(),
				};
			}),
		async revert(params: unknown) {
			const {
				id,
				operationId,
				confirmConflicts = [],
			} = parseRequest({
				schema: revertSchema,
				params,
			});
			return profileChange(() =>
				serialized(async () => {
					const updates = await readUpdates();
					const previous = updates.find(
						(update) => update.operation?.id === operationId,
					);
					if (previous) {
						if (
							previous.reverts !== id ||
							JSON.stringify(previous.confirmedConflicts ?? []) !==
								JSON.stringify(confirmConflicts)
						)
							throw invalidParams(
								"This operation ID was already used with different arguments.",
							);
						return applyResult(previous);
					}
					const index = updates.findIndex((update) => update.id === id);
					const target = updates[index];
					const latest = updates.at(-1);
					const text = await readProfile();
					const history = revertHistory(updates);
					if (
						!target ||
						latest?.text !== text ||
						!history.canRevert(target, index)
					)
						throw invalidParams(
							"This profile update can no longer be reverted.",
						);
					const conflicts = history.conflictsAt(index);
					if (JSON.stringify(conflicts) !== JSON.stringify(confirmConflicts))
						throw invalidParams(
							conflicts.length
								? `This revert conflicts with update ${conflicts.join(", ")}. Review the conflicts before confirming.`
								: "Revert conflicts changed. Review this update before trying again.",
						);
					const entries = history.inverseAt(index, entriesFor(text, latest));
					return apply({
						text: renderProfile(entries),
						entries,
						correctionIds: [],
						expectedVersion: versionOf(text),
						operationId,
						reverts: id,
						confirmedConflicts: confirmConflicts,
					});
				}),
			);
		},
		question: () =>
			serialized(async () =>
				activeQuestion({
					updates: await readUpdates(),
					responses: await readResponses(),
				}),
			),
		async respond(params: unknown) {
			const response = parseRequest({
				schema: profileQuestionResponseSchema,
				params,
			});
			return serialized(async () => {
				const responses = await readResponses();
				const previous = responses.find(
					({ question }) => question.id === response.id,
				);
				const answer = response.kind === "answer" ? response.answer : null;
				if (previous?.answer === answer) return null;
				const question = activeQuestion({
					updates: await readUpdates(),
					responses,
				});
				if (!question || question.id !== response.id)
					throw invalidParams("This profile question has already closed.");
				await replace({
					path: responsesPath,
					text: JSON.stringify([...responses, { question, answer }]),
				});
				return null;
			});
		},
		analyze({
			signal,
			analyze,
		}: {
			signal: AbortSignal;
			analyze: (batch: {
				preferences: Preference[];
				corrections: Awaited<ReturnType<typeof readCorrections>>;
				answers: { id: string; question: string; answer: string }[];
				canAsk: boolean;
			}) => Promise<unknown>;
		}) {
			return profileChange(async () => {
				if (signal.aborted) return false;
				const batch = await serialized(async () => {
					const updates = await readUpdates();
					const responses = await readResponses();
					const used = new Set(
						updates.flatMap(({ answerIds }) => answerIds ?? []),
					);
					const text = await readProfile();
					return {
						text,
						entries: entriesFor(text, updates.at(-1)),
						corrections: (await readCorrections(pendingPath)).slice(0, 12),
						evidence: responses
							.flatMap(({ question, answer }) =>
								answer !== null && !used.has(question.id)
									? [{ id: question.id, question: question.text, answer }]
									: [],
							)
							.slice(0, 4),
						canAsk: !activeQuestion({ updates, responses }),
					};
				});
				if (
					signal.aborted ||
					(!batch.corrections.length && !batch.evidence.length)
				)
					return false;
				const result = await analyze({
					preferences: batch.entries.filter((entry) => entry.kind !== "manual"),
					corrections: batch.corrections,
					answers: batch.evidence,
					canAsk: batch.canAsk && batch.corrections.length > 0,
				});
				return serialized(async () => {
					if (signal.aborted) return false;
					const correctionIds = batch.corrections.map(({ id }) => id);
					const answerIds = batch.evidence.map(({ id }) => id);
					const { preferences, question } = validateAnalysis({
						result,
						evidence: new Set([...correctionIds, ...answerIds]),
					});
					const entries = new Map(
						batch.entries.map((entry) => [entry.kind, entry]),
					);
					for (const preference of preferences) {
						entries.set(preference.kind, preference);
					}
					const after = [...entries.values()];
					await apply({
						text: renderProfile(after),
						entries: after,
						correctionIds,
						answerIds,
						signal,
						expectedVersion: versionOf(batch.text),
						operationId: randomUUID(),
						question:
							batch.canAsk && correctionIds.length && question
								? { id: randomUUID(), text: question }
								: undefined,
					});
					return true;
				});
			});
		},
	};
}

function applyResult({
	id,
	correctionIds,
	text,
}: z.infer<typeof updateSchema>) {
	return {
		updateId: id,
		applied: correctionIds.length,
		version: versionOf(text),
	};
}
