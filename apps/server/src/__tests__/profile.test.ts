import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Correction, CorrectionStatusEvent } from "@splice/bridge/profile";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileAgent } from "../profile-agent";
import type { ProfileProvider } from "../profile-provider";
import { createProfileStore } from "../profile";

let root: string;
let directory: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "splice-profile-"));
	directory = join(root, "Profile");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const read = (file: string) => readFile(join(directory, file), "utf8");
const readLines = async (file: string) =>
	(await read(file))
		.trim()
		.split("\n")
		.map((record) => JSON.parse(record));
const write = ({ file, text }: { file: string; text: string | Buffer }) =>
	writeFile(join(directory, file), text);
const line = (record: unknown) => JSON.stringify(record) + "\n";

function correction(revision: number): Correction {
	const before = {
		projectItemId: "rec",
		recording: "Footage/voix-é.wav",
		sourceIn: 4,
		sourceOut: 8,
	};
	return {
		id: randomUUID(),
		timestamp: "2026-11-25T12:00:00.000Z",
		projectId: "project",
		sequenceId: "rough",
		revision,
		kind: "retrim",
		before: [before],
		after: [{ ...before, sourceOut: 8.3 }],
		decision: {
			kind: "pause",
			edge: "out",
			sourceIn: 8,
			sourceOut: 9,
			removedSeconds: 1,
			pauseSeconds: 1.4,
		},
	};
}

test("initializes the template and leaves an existing editing profile intact", async () => {
	const store = createProfileStore({ root });
	const { text } = await store.read();
	expect(text).toContain("# Editing profile");
	expect(await read("profile.md")).toBe(text);
	await write({ file: "profile.md", text: "# Creator preferences" });
	expect(await createProfileStore({ root }).read()).toMatchObject({
		text: "# Creator preferences",
	});
});

test("serializes simultaneous capture, deduplicates retries after restart, and pages pending Corrections", async () => {
	const first = correction(1);
	const second = correction(2);
	const third = correction(3);
	const store = createProfileStore({ root });
	await Promise.all([
		store.capture({ corrections: [first, first] }),
		store.capture({ corrections: [second, third] }),
	]);
	const restarted = createProfileStore({ root });
	expect(await restarted.capture({ corrections: [second] })).toEqual({
		recorded: 0,
	});
	expect(await readLines("corrections.jsonl")).toEqual([first, second, third]);
	expect(await restarted.pending({ limit: 2 })).toEqual({
		corrections: [first, second],
		nextCursor: second.id,
	});
	expect(await restarted.pending({ after: second.id, limit: 2 })).toEqual({
		corrections: [third],
		nextCursor: null,
	});
});

test("applies exactly the reviewed IDs and records the previous Markdown", async () => {
	const first = correction(1);
	const second = correction(2);
	const store = createProfileStore({ root });
	const original = await store.read();
	await store.capture({ corrections: [first, second] });
	const text = "# Editing profile\n\nKeep longer breaths.";
	const update = await store.apply({
		text,
		correctionIds: [first.id],
		expectedVersion: original.version,
		operationId: randomUUID(),
	});
	expect(update.applied).toBe(1);
	expect(await read("profile.md")).toBe(text);
	expect(await readLines("pending.jsonl")).toEqual([second]);
	expect(await readLines("corrections.jsonl")).toEqual([first, second]);
	expect(JSON.parse(await read("updates.jsonl"))).toMatchObject({
		id: update.updateId,
		previousText: original.text,
		text,
		correctionIds: [first.id],
	});
	await expect(
		store.apply({
			text,
			correctionIds: [second.id],
			expectedVersion: original.version,
			operationId: randomUUID(),
		}),
	).rejects.toThrow("profile changed");
	await expect(
		store.apply({
			text,
			correctionIds: [first.id, second.id],
			expectedVersion: update.version,
			operationId: randomUUID(),
		}),
	).rejects.toThrow("must still be pending");
	await expect(store.pending({ after: first.id })).rejects.toThrow(
		"cursor is no longer pending",
	);
	expect(await store.pending({})).toEqual({
		corrections: [second],
		nextCursor: null,
	});
});

test("requires a version and rejects the second concurrent apply from the same profile", async () => {
	const first = correction(1);
	const second = correction(2);
	const store = createProfileStore({ root });
	await store.capture({ events: [first, second] });
	const { version } = await store.read();
	const firstRequest = {
		text: "# First update",
		correctionIds: [first.id],
		operationId: randomUUID(),
	};
	await expect(store.apply(firstRequest)).rejects.toThrow("expectedVersion");
	const [winner, stale] = await Promise.allSettled([
		store.apply({ ...firstRequest, expectedVersion: version }),
		store.apply({
			text: "# Second update",
			correctionIds: [second.id],
			operationId: randomUUID(),
			expectedVersion: version,
		}),
	]);
	expect(winner.status).toBe("fulfilled");
	expect(stale).toMatchObject({
		status: "rejected",
		reason: { message: expect.stringContaining("profile changed") },
	});
	expect(await store.read()).toMatchObject({ text: firstRequest.text });
	expect(await store.pending({})).toEqual({
		corrections: [second],
		nextCursor: null,
	});
});

test("returns the original apply result after restart and later updates", async () => {
	const first = correction(1);
	const second = correction(2);
	const store = createProfileStore({ root });
	await store.capture({ events: [first, second] });
	const request = {
		operationId: randomUUID(),
		text: "# First update",
		correctionIds: [first.id],
		expectedVersion: (await store.read()).version,
	};
	const applied = await store.apply(request);
	const next = await store.apply({
		operationId: randomUUID(),
		text: "# Second update",
		correctionIds: [second.id],
		expectedVersion: applied.version,
	});
	const restarted = createProfileStore({ root });
	expect(await restarted.apply(request)).toEqual(applied);
	await expect(
		restarted.apply({ ...request, text: "# Changed retry" }),
	).rejects.toThrow("already used with different arguments");
	expect(await restarted.read()).toEqual({
		text: "# Second update",
		version: next.version,
	});
	expect(await readLines("updates.jsonl")).toHaveLength(2);
});

test("keeps undo and redo in the raw log and reactivates the original pending ID", async () => {
	const original = correction(1);
	const undone: CorrectionStatusEvent = {
		id: randomUUID(),
		correctionId: original.id,
		kind: "cancel",
		revision: 2,
		projectId: original.projectId,
		sequenceId: original.sequenceId,
		timestamp: original.timestamp,
	};
	const redone: CorrectionStatusEvent = {
		...undone,
		id: randomUUID(),
		kind: "reactivate",
		revision: 3,
	};
	const store = createProfileStore({ root });
	await store.capture({ events: [original, undone] });
	expect(await store.pending({})).toEqual({
		corrections: [],
		nextCursor: null,
	});
	await expect(
		store.apply({
			operationId: randomUUID(),
			text: "# Canceled update",
			correctionIds: [original.id],
			expectedVersion: (await store.read()).version,
		}),
	).rejects.toThrow("must still be pending");

	const restarted = createProfileStore({ root });
	await restarted.capture({ events: [redone] });
	expect(
		await restarted.capture({ events: [original, undone, redone] }),
	).toEqual({ recorded: 0 });
	expect(await restarted.pending({})).toEqual({
		corrections: [original],
		nextCursor: null,
	});
	expect(await readLines("corrections.jsonl")).toEqual([
		original,
		undone,
		redone,
	]);
	await restarted.apply({
		operationId: randomUUID(),
		text: "# Applied preference",
		correctionIds: [original.id],
		expectedVersion: (await restarted.read()).version,
	});
	await restarted.capture({
		events: [
			{ ...undone, id: randomUUID(), revision: 4 },
			{ ...redone, id: randomUUID(), revision: 5 },
		],
	});
	expect(await restarted.pending({})).toEqual({
		corrections: [],
		nextCursor: null,
	});
	expect(await restarted.read()).toMatchObject({
		text: "# Applied preference",
	});
});

test("recovers a partial append through a UTF-8 recording name without duplicating any rows", async () => {
	const first = correction(1);
	const second = correction(2);
	await mkdir(directory);
	const bytes = Buffer.from(line(second));
	const split = bytes.indexOf("é") + 1;
	await write({
		file: "corrections.jsonl",
		text: Buffer.concat([Buffer.from(line(first)), bytes.subarray(0, split)]),
	});
	await write({ file: "pending.jsonl", text: line(first) });
	await write({
		file: "transaction.json",
		text: JSON.stringify({
			kind: "capture",
			offset: Buffer.byteLength(line(first)),
			lines: line(second),
		}),
	});

	const store = createProfileStore({ root });
	expect(await store.pending({})).toEqual({
		corrections: [first, second],
		nextCursor: null,
	});
	expect(await readLines("corrections.jsonl")).toEqual([first, second]);
	expect(await readLines("pending.jsonl")).toEqual([first, second]);
	expect(await store.capture({ corrections: [second] })).toEqual({
		recorded: 0,
	});
});

test("finishes a restarted apply whose history row and profile were already written", async () => {
	const first = correction(1);
	const second = correction(2);
	const store = createProfileStore({ root });
	const original = await store.read();
	await store.capture({ corrections: [first, second] });
	const update = {
		id: randomUUID(),
		timestamp: first.timestamp,
		correctionIds: [first.id],
		previousText: original.text,
		text: "# Keep longer breaths",
	};
	await write({ file: "updates.jsonl", text: line(update) });
	await write({ file: "profile.md", text: update.text });
	await write({
		file: "transaction.json",
		text: JSON.stringify({ kind: "apply", offset: 0, lines: line(update) }),
	});

	const restarted = createProfileStore({ root });
	expect(await restarted.read()).toMatchObject({ text: update.text });
	expect(await restarted.pending({})).toEqual({
		corrections: [second],
		nextCursor: null,
	});
	expect(await read("updates.jsonl")).toBe(line(update));
});

test("reverts the latest text change by writing an idempotent update", async () => {
	const store = createProfileStore({ root });
	const original = await store.read();
	const first = correction(1);
	const second = correction(2);
	const third = correction(3);
	await store.capture({ corrections: [first, second, third] });
	const older = await store.apply({
		text: "Keep a breath between sentences.",
		correctionIds: [first.id],
		expectedVersion: original.version,
		operationId: randomUUID(),
	});
	const latest = await store.apply({
		text: "Tighten pauses in fast passages.",
		correctionIds: [second.id],
		expectedVersion: older.version,
		operationId: randomUUID(),
	});
	// An evidence-only update should leave the latest text change revertible.
	await store.apply({
		text: "Tighten pauses in fast passages.",
		correctionIds: [third.id],
		expectedVersion: latest.version,
		operationId: randomUUID(),
	});
	await expect(
		store.revert({ id: older.updateId, operationId: randomUUID() }),
	).rejects.toThrow("Only the latest change");
	const params = { id: latest.updateId, operationId: randomUUID() };
	const result = await store.revert(params);
	const restarted = createProfileStore({ root });
	expect(await restarted.revert(params)).toEqual(result);
	expect(await restarted.read()).toEqual({
		text: "Keep a breath between sentences.",
		version: older.version,
	});
	expect((await restarted.panel()).updates).toHaveLength(4);
	expect((await restarted.panel()).updates[0]).toMatchObject({
		reverts: latest.updateId,
		canRevert: true,
		correctionCount: 0,
	});
	expect((await restarted.pending({})).corrections).toEqual([]);
});

function agentHarness({
	provider,
	timeoutMs,
}: {
	provider: ProfileProvider | null;
	timeoutMs?: number;
}) {
	const store = createProfileStore({ root });
	let time = 0;
	let connected = false;
	const failures: number[] = [];
	const agent = createProfileAgent({
		store,
		getProvider: async () => provider,
		isConnected: () => connected,
		now: () => time,
		timeoutMs,
		onFailure: () => failures.push(time),
	});
	return {
		store,
		agent,
		failures,
		connect() {
			connected = true;
			agent.activity();
		},
		async advance(ms: number) {
			time += ms;
			await agent.tick();
		},
	};
}

test("waits for thirty seconds without editor activity and preserves corrections with the provider off", async () => {
	const prompts: string[] = [];
	const h = agentHarness({
		provider: async ({ prompt }) => {
			prompts.push(prompt);
			return { text: "Keep longer breaths.", question: null };
		},
	});
	await h.store.capture({ corrections: [correction(1)] });
	await h.advance(35_000);
	expect(prompts).toHaveLength(0);
	h.connect();
	await h.advance(29_999);
	h.agent.activity();
	await h.advance(29_999);
	expect(prompts).toHaveLength(0);
	await h.advance(1);
	expect(prompts).toHaveLength(1);
	expect(await h.store.read()).toMatchObject({ text: "Keep longer breaths." });
	expect((await h.store.pending({})).corrections).toEqual([]);
	const off = agentHarness({ provider: null });
	const pending = correction(2);
	await off.store.capture({ corrections: [pending] });
	off.connect();
	await off.advance(30_000);
	expect((await off.store.pending({})).corrections).toEqual([pending]);
});

test("bounds correction batches and stores one question and its answer across restart", async () => {
	const prompts: string[] = [];
	const h = agentHarness({
		provider: async ({ prompt }) => {
			prompts.push(prompt);
			return {
				text: "Keep longer breaths.",
				question: "How much breath do you leave?",
			};
		},
	});
	await h.store.capture({
		corrections: Array.from({ length: 13 }, (_, index) => correction(index)),
	});
	h.connect();
	await h.advance(30_000);
	const question = await h.store.question();
	expect(question?.text).toBe("How much breath do you leave?");
	expect((await h.store.pending({})).corrections).toHaveLength(1);
	await h.advance(2_000);
	expect(await h.store.question()).toEqual(question);
	expect(await readLines("updates.jsonl")).toHaveLength(2);
	const restarted = createProfileStore({ root });
	expect(await restarted.question()).toEqual(question);
	if (!question) throw new Error("Expected a profile question");
	const response = {
		kind: "answer",
		id: question.id,
		answer: "Usually half a second.",
	};
	await restarted.respond(response);
	await restarted.respond(response);
	const next = agentHarness({
		provider: async ({ prompt }) => {
			expect(prompt).toContain(response.answer);
			expect(prompt).toContain(question.text);
			return {
				text: "Leave half a second for breath.",
				question: "An answer-only batch cannot ask this.",
			};
		},
	});
	next.connect();
	await next.advance(30_000);
	expect(await next.store.question()).toBeNull();
	expect((await next.store.panel()).updates[0]).toMatchObject({
		correctionCount: 0,
		answerCount: 1,
	});
	expect(await next.store.read()).toMatchObject({
		text: "Leave half a second for breath.",
	});
	expect(prompts[0]).not.toContain("Footage/voix-é.wav");
	expect(prompts[1]).toContain("Set question to null.");
});

test("persists a dismissal without creating answer evidence", async () => {
	const h = agentHarness({
		provider: async () => ({ text: "Keep some space.", question: "How much?" }),
	});
	await h.store.capture({ corrections: [correction(1)] });
	h.connect();
	await h.advance(30_000);
	const question = await h.store.question();
	if (!question) throw new Error("Expected a profile question");
	await h.store.respond({ kind: "dismiss", id: question.id });
	expect(await createProfileStore({ root }).question()).toBeNull();
	await h.advance(2_000);
	expect((await h.store.panel()).updates).toHaveLength(1);
});

test("leaves evidence pending on malformed output, timeout, or failure and retries after backoff", async () => {
	let attempts = 0;
	const h = agentHarness({
		timeoutMs: 30,
		provider: async ({ signal }) => {
			attempts++;
			switch (attempts) {
				case 1:
					return { text: "Invalid question list", question: ["One?", "Two?"] };
				case 2:
					await Bun.sleep(50);
					signal.throwIfAborted();
					return null;
				case 3:
					throw new Error("Provider rejected the request");
				default:
					return { text: "Keep more silence.", question: null };
			}
		},
	});
	const pending = correction(1);
	await h.store.capture({ corrections: [pending] });
	h.connect();
	await h.advance(30_000);
	await h.advance(59_999);
	expect(attempts).toBe(1);
	await h.advance(1);
	await h.advance(60_000);
	expect(h.failures).toHaveLength(3);
	expect((await h.store.panel()).updates).toHaveLength(0);
	expect((await h.store.pending({})).corrections).toEqual([pending]);
	await h.advance(60_000);
	expect((await h.store.pending({})).corrections).toEqual([]);
});

test("holds MCP apply until analysis ends and cancels analysis when editing resumes", async () => {
	const entered = Promise.withResolvers<void>();
	const leave = Promise.withResolvers<void>();
	const h = agentHarness({
		provider: async () => {
			entered.resolve();
			await leave.promise;
			return { text: "Stale analysis", question: "Stale question?" };
		},
	});
	const pending = correction(1);
	await h.store.capture({ corrections: [pending] });
	const profile = await h.store.read();
	h.connect();
	const analysis = h.advance(30_000);
	await entered.promise;
	let applied = false;
	const mcp = h.store
		.apply({
			text: "MCP update",
			correctionIds: [pending.id],
			expectedVersion: profile.version,
			operationId: randomUUID(),
		})
		.then(() => {
			applied = true;
		});
	expect(await h.store.read()).toEqual(profile);
	expect(applied).toBe(false);
	h.agent.activity();
	leave.resolve();
	await Promise.all([analysis, mcp]);
	expect(await h.store.question()).toBeNull();
	expect(await h.store.read()).toMatchObject({ text: "MCP update" });
});
