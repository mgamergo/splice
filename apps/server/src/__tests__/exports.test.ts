import { afterEach, describe, expect, test } from "bun:test";
import { BRIDGE_PATHS, parseRpcMessage } from "@splice/bridge";
import type { ExportSource } from "@splice/bridge/delivery";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExportStore, exportStem } from "../exports";
import { createRpcClient } from "../rpc-client";
import { type RunningServer, startServer } from "../server";
import { createSpellingStore } from "../spellings";

const TOKEN = "test-token";
const roots: string[] = [];
const running: RunningServer[] = [];

afterEach(async () => {
	for (const server of running.splice(0)) await server.stop();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "splice-exports-"));
	roots.push(root);
	return root;
}

const source: ExportSource = {
	projectId: "project-1",
	projectName: "My: Tutorial?",
	sequenceId: "sequence-1",
	sequenceName: "Rough Cut",
	revision: 42,
	fingerprint: "0123456789abcdef",
	durationSeconds: 60,
	cueCount: 2,
};

const body = (text: string) => new Response(text).body;

describe("exportStem", () => {
	test("makes a Windows-safe name from the project and time", () => {
		const at = new Date(2026, 10, 24, 9, 5, 7);
		expect(exportStem({ projectName: "My: Tutorial?", at })).toBe(
			"My Tutorial 2026-11-24 09.05.07",
		);
		expect(exportStem({ projectName: ' <>"..  ', at })).toBe(
			"Export 2026-11-24 09.05.07",
		);
	});
});

describe("the export store", () => {
	test("publishes the MP4 and SRT together under one stem and keeps earlier pairs", async () => {
		const root = await tempRoot();
		const at = new Date(2026, 10, 24, 9, 5, 7);
		const store = createExportStore({ root, now: () => at });

		const first = await store.begin(source);
		await store.write({ ...first, kind: "mp4", offset: 0, body: body("video-1") });
		await store.write({ ...first, kind: "srt", offset: 0, body: body("1\n") });
		const published = await store.publish(first);
		expect(published).toMatchObject({
			...source,
			stem: "My Tutorial 2026-11-24 09.05.07",
			bytes: { mp4: 7, srt: 2 },
		});

		// Same second: the second pair gets its own stem.
		const second = await store.begin({ ...source, revision: 43 });
		await store.write({ ...second, kind: "srt", offset: 0, body: body("2\n") });
		await store.write({ ...second, kind: "mp4", offset: 0, body: body("video-2") });
		await store.publish(second);

		const folder = join(root, "Exports");
		expect((await readdir(folder)).filter((name) => !name.startsWith(".")).sort()).toEqual([
			"My Tutorial 2026-11-24 09.05.07 (2).mp4",
			"My Tutorial 2026-11-24 09.05.07 (2).srt",
			"My Tutorial 2026-11-24 09.05.07.mp4",
			"My Tutorial 2026-11-24 09.05.07.srt",
			"exports.json",
		]);
		expect(
			await readFile(join(folder, "My Tutorial 2026-11-24 09.05.07.mp4"), "utf8"),
		).toBe("video-1");
		const { exports } = await store.list({ projectId: "project-1" });
		expect(exports.map(({ revision, present }) => [revision, present])).toEqual([
			[43, true],
			[42, true],
		]);
		expect((await store.list({ projectId: "other" })).exports).toEqual([]);
	});

	test("publishes nothing until both files are written, and an abort drops the staged files", async () => {
		const root = await tempRoot();
		const store = createExportStore({ root });
		const previous = await store.begin(source);
		await store.write({ ...previous, kind: "mp4", offset: 0, body: body("old") });
		await store.write({ ...previous, kind: "srt", offset: 0, body: body("old") });
		const kept = await store.publish(previous);

		const failed = await store.begin({ ...source, revision: 50 });
		await store.write({ ...failed, kind: "mp4", offset: 0, body: body("new") });
		await expect(store.publish(failed)).rejects.toThrow("SRT was not written");
		await store.abort(failed);
		await expect(
			store.write({ ...failed, kind: "srt", offset: 0, body: body("late") }),
		).rejects.toThrow("not started");

		const { exports } = await store.list({});
		expect(exports.map(({ stem }) => stem)).toEqual([kept.stem]);
		expect(await readdir(join(root, "Exports", ".staging"))).toEqual([]);
		expect(await readFile(join(root, "Exports", `${kept.stem}.mp4`), "utf8")).toBe(
			"old",
		);
	});

	test("reports a pair whose files were moved, and opens the folder", async () => {
		const root = await tempRoot();
		const opened: string[] = [];
		const store = createExportStore({
			root,
			openFolder: async (folder) => {
				opened.push(folder);
			},
		});
		const pair = await store.begin(source);
		await store.write({ ...pair, kind: "mp4", offset: 0, body: body("v") });
		await store.write({ ...pair, kind: "srt", offset: 0, body: body("s") });
		const { stem } = await store.publish(pair);
		await rm(join(root, "Exports", `${stem}.srt`));
		expect((await store.list({})).exports[0].present).toBe(false);
		expect(await store.open()).toEqual({
			opened: true,
			folder: join(root, "Exports"),
		});
		expect(opened).toEqual([join(root, "Exports")]);

		const failing = createExportStore({
			root,
			openFolder: async () => {
				throw new Error("no file manager");
			},
		});
		expect(await failing.open()).toMatchObject({
			opened: false,
			error: "Couldn't open a file manager: no file manager",
		});
	});
});

describe("saved spellings", () => {
	test("saving the same words again replaces the spelling", async () => {
		const root = await tempRoot();
		const spellings = createSpellingStore({ root });
		expect(await spellings.list()).toEqual({ spellings: [] });
		await spellings.save({ from: "next js", to: "Next.js" });
		await spellings.save({ from: "Kubernetes", to: "Kubernetes" });
		expect(await spellings.save({ from: "Next  JS", to: "NextJS" })).toEqual({
			spellings: [
				{ from: "Kubernetes", to: "Kubernetes" },
				{ from: "Next  JS", to: "NextJS" },
			],
		});
		await spellings.remove({ from: "kubernetes" });
		expect(
			JSON.parse(await readFile(join(root, "Profile", "spellings.json"), "utf8")),
		).toEqual({ version: 1, spellings: [{ from: "Next  JS", to: "NextJS" }] });
		await expect(spellings.save({ from: "", to: "x" })).rejects.toThrow();
	});

	test("a corrupt spellings file is reported, not overwritten", async () => {
		const root = await tempRoot();
		await Bun.write(join(root, "Profile", "spellings.json"), '{"version":2}');
		const spellings = createSpellingStore({ root });
		await expect(spellings.list()).rejects.toThrow("not a valid spellings file");
	});
});

describe("the tab's API on splice", () => {
	async function start() {
		const root = await tempRoot();
		const server = startServer({
			port: 0,
			token: TOKEN,
			root,
			upstream: null,
			openFolder: async () => {},
		});
		running.push(server);
		return { server, root };
	}

	async function call({
		origin,
		method,
		params,
		headers,
	}: {
		origin: string;
		method: string;
		params?: unknown;
		headers?: Record<string, string>;
	}) {
		const response = await fetch(`${origin}${BRIDGE_PATHS.api}`, {
			method: "POST",
			headers: headers ?? {
				origin,
				authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		return { status: response.status, message: parseRpcMessage(await response.text()) };
	}

	test("needs the editor's origin and the bridge token", async () => {
		const { server } = await start();
		const { origin } = server;
		expect(
			(await call({ origin, method: "spellings.list", headers: { authorization: `Bearer ${TOKEN}` } }))
				.status,
		).toBe(403);
		expect(
			(await call({ origin, method: "spellings.list", headers: { origin, authorization: "Bearer nope" } }))
				.status,
		).toBe(401);
		expect(
			(await call({ origin, method: "spellings.list", headers: { origin: "http://evil.test", authorization: `Bearer ${TOKEN}` } }))
				.status,
		).toBe(403);
		const unknown = await call({ origin, method: "editor.apply" });
		expect(unknown.message).toMatchObject({ error: { message: "Unknown method editor.apply" } });
	});

	test("publishes a pair uploaded by the tab, and splice mcp lists it", async () => {
		const { server, root } = await start();
		const { origin } = server;
		const begun = await call({ origin, method: "exports.begin", params: source });
		const { exportId } = (begun.message as { result: { exportId: string } }).result;
		const video = new Uint8Array(3 * 1024 * 1024).fill(7);
		// eslint-disable-next-line opencut/prefer-object-params -- terse test data
		const put = (kind: string, offset: number, data: Uint8Array | string) =>
			fetch(`${origin}${BRIDGE_PATHS.api}/exports/${exportId}/${kind}?offset=${offset}`, {
				method: "PUT",
				headers: { origin, authorization: `Bearer ${TOKEN}` },
				body: data,
			});
		// The MP4 in two chunks; a chunk out of order is refused.
		expect((await put("mp4", 0, video.subarray(0, 2_000_000))).status).toBe(200);
		const skipped = await put("mp4", 3_000_000, video.subarray(2_000_000));
		expect(parseRpcMessage(await skipped.text())).toMatchObject({
			error: { message: "The MP4 continues at byte 2000000, not 3000000." },
		});
		expect((await put("mp4", 2_000_000, video.subarray(2_000_000))).status).toBe(200);
		expect((await put("srt", 0, "1\n00:00:00,000 --> 00:00:01,000\nHi\n")).status).toBe(200);
		expect((await put("srt", -1, "x")).status).toBe(400);
		const published = await call({ origin, method: "exports.publish", params: { exportId } });
		const record = (published.message as { result: { stem: string; bytes: { mp4: number } } }).result;
		expect(record.bytes.mp4).toBe(video.length);
		expect((await Bun.file(join(root, "Exports", `${record.stem}.srt`)).text()).trim()).toEndWith("Hi");

		const mcp = createRpcClient({ origin, token: TOKEN });
		const listed = (await mcp({ method: "exports.list", params: {} })) as {
			exports: Array<{ stem: string; files: { mp4: string } }>;
		};
		expect(listed.exports.map(({ stem }) => stem)).toEqual([record.stem]);
		expect(listed.exports[0].files.mp4).toBe(`${record.stem}.mp4`);
	});

	test("a bad upload path or method is refused", async () => {
		const { server } = await start();
		const { origin } = server;
		const headers = { origin, authorization: `Bearer ${TOKEN}` };
		const unknown = await fetch(
			`${origin}${BRIDGE_PATHS.api}/exports/00000000-0000-0000-0000-000000000000/mp4`,
			{ method: "PUT", headers, body: "x" },
		);
		expect(parseRpcMessage(await unknown.text())).toMatchObject({
			error: { message: expect.stringContaining("not started") },
		});
		const traversal = await fetch(`${origin}${BRIDGE_PATHS.api}/exports/..%2F..%2Fx/mp4`, {
			method: "PUT",
			headers,
			body: "x",
		});
		expect(traversal.status).toBe(404);
	});
});
