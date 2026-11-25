import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Correction, CorrectionStatusEvent } from "@splice/bridge/profile";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	expect(await restarted.read()).toMatchObject({ text: "# Applied preference" });
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
