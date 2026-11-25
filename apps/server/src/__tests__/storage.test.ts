import { afterEach, expect, test } from "bun:test";
import { BRIDGE_PATHS, denoisedAudioUrlForPath } from "@splice/bridge";
import { storageReportSchema } from "@splice/bridge/storage";
import {
	link,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCacheUse } from "../cache-use";
import { createExportStore } from "../exports";
import { createNoiseReducer } from "../noise-reduction";
import { createRpcClient } from "../rpc-client";
import { lockRoot } from "../root-lock";
import { startServer } from "../server";
import { createStorage } from "../storage";

const roots: string[] = [];
const KEY = "a".repeat(64);

afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "splice-storage-"));
	roots.push(root);
	const cacheUse = createCacheUse();
	const exportStore = createExportStore({ root });
	const storage = createStorage({ root, cacheUse, exportStore });
	async function save(path: string) {
		const file = join(root, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, "1234");
		return file;
	}
	return { root, storage, cacheUse, exportStore, save };
}

test("classifies disk data, defaults to dry run, and applies age and category filters", async () => {
	const { root, storage, save } = await setup();
	const pause = await save(`Cache/pauses/${KEY}.json`);
	const loudness = await save(`Cache/loudness/audio-${KEY}.mka`);
	const temporary = await save(
		"Cache/noise-reduction/.job-abandoned/denoised.wav",
	);
	const abandoned = await save("Exports/.staging/abandoned/mp4");
	const kept = [
		await save("Footage/original.mov"),
		await save("Footage/approved-graphic.png"),
		await save("Footage/approved-music.wav"),
		await save("Projects/checkpoint.json"),
		await save("Projects/corrected-captions.json"),
		await save("Exports/published/published.mp4"),
		await save("Exports/published/published.srt"),
		await save("Profile/spellings.json"),
		await save("Profile/Cache/pauses/unknown.json"),
		await save("Tools/ffmpeg"),
		await save("outside-folders.txt"),
		await save("Cache/session.json"),
		await save("Cache/loudness/unknown.json"),
		await save(`Cache/transcripts/${KEY}.json`),
	];
	await utimes(pause, 1, 1);

	const preview = await storage.cleanup({});
	expect(preview).toMatchObject({
		dryRun: true,
		freedBytes: 0,
		reclaimableBytes: 16,
		errors: [],
	});
	expect(
		preview.kept.find(({ category }) => category === "transcripts"),
	).toMatchObject({
		bytes: 4,
		reason: expect.stringContaining("captions and corrections"),
	});
	expect(await readFile(pause, "utf8")).toBe("1234");

	expect(
		await storage.cleanup({
			dryRun: false,
			olderThanDays: 1,
			categories: ["pauses", "loudness"],
		}),
	).toMatchObject({ freedBytes: 4, reclaimableBytes: 4, errors: [] });
	await expect(readFile(pause)).rejects.toHaveProperty("code", "ENOENT");
	expect(await readFile(loudness, "utf8")).toBe("1234");

	const applied = await storage.cleanup({ dryRun: false });
	expect(applied).toMatchObject({
		freedBytes: 12,
		reclaimableBytes: 12,
		errors: [],
	});
	for (const path of [loudness, dirname(temporary), dirname(abandoned)])
		await expect(readFile(path)).rejects.toHaveProperty("code", "ENOENT");
	for (const path of kept) expect(await readFile(path, "utf8")).toBe("1234");
	expect(await storage.report({ categories: [] })).toMatchObject({
		reclaimableBytes: 0,
	});
	expect(await storage.report({})).toMatchObject({ reclaimableBytes: 0 });
	expect(await readFile(join(root, "Cache", "session.json"), "utf8")).toBe(
		"1234",
	);
});

test("preserves links, their protected targets, and files shared with original recordings", async () => {
	const { root, storage, save } = await setup();
	const original = await save("Projects/checkpoint.json");
	const hardLink = join(root, "Cache", "pauses", `${KEY}.json`);
	const aliasTarget = await save(`Cache/noise-reduction/${KEY}.wav`);
	const staged = await save("Exports/.staging/old/mp4");
	await mkdir(dirname(hardLink), { recursive: true });
	await link(original, hardLink);
	await symlink(dirname(aliasTarget), join(root, "Footage"), "junction");
	await symlink(original, join(dirname(staged), "link"), "file");
	await symlink(dirname(original), join(root, "Cache", "loudness"), "junction");

	const result = await storage.cleanup({ dryRun: false });
	expect(result).toMatchObject({
		freedBytes: 0,
		reclaimableBytes: 0,
		errors: [],
	});
	expect(result.kept.some(({ reason }) => reason.includes("linked"))).toBe(
		true,
	);
	for (const path of [original, hardLink, aliasTarget, staged])
		expect(await readFile(path, "utf8")).toBe("1234");
});

test("skips a reserved export and removes only abandoned staging while the export can publish", async () => {
	const { storage, exportStore, save } = await setup();
	const request = {
		deliveryId: crypto.randomUUID(),
		projectId: "project",
		projectName: "Video",
		sequenceId: "sequence",
		sequenceName: "Rough Cut",
		revision: 1,
		fingerprint: "0123456789abcdef",
		durationSeconds: 2,
		cueCount: 1,
	};
	const stale = await save("Exports/.staging/from-a-prior-run/mp4");
	const begun = await exportStore.begin(request);
	if (!("exportId" in begun)) throw new Error("Expected a reservation.");
	await exportStore.write({
		...begun,
		kind: "mp4",
		offset: 0,
		body: new Response("video").body,
	});
	const result = await storage.cleanup({ dryRun: false });
	expect(result.freedBytes).toBe(4);
	expect(result.kept).toContainEqual({
		category: "export-staging",
		reason: "In use by a running job",
		bytes: 5,
		items: 1,
	});
	await expect(readFile(stale)).rejects.toHaveProperty("code", "ENOENT");
	await exportStore.write({
		...begun,
		kind: "srt",
		offset: 0,
		body: new Response("captions").body,
	});
	await expect(exportStore.publish(begun)).resolves.toMatchObject({
		bytes: { mp4: 5, srt: 8 },
	});
	expect(await storage.cleanup({ dryRun: false })).toMatchObject({
		freedBytes: 0,
	});
});

test("protects shared work after its last caller disconnects and until the job settles", async () => {
	const { root, storage, cacheUse, save } = await setup();
	await save("Footage/source.wav");
	const idle = await save(`Cache/noise-reduction/${KEY}.wav`);
	const started = Promise.withResolvers<string>();
	const finished = Promise.withResolvers<void>();
	const caller = new AbortController();
	const reducer = createNoiseReducer({
		root,
		cacheUse,
		async render({ output, signal }) {
			await writeFile(output, "partial render");
			started.resolve(output);
			await finished.promise;
			signal.throwIfAborted();
			return { noiseWindow: null };
		},
	});
	const rendering = reducer.ensure({
		path: "source.wav",
		signal: caller.signal,
	});
	try {
		const output = await started.promise;
		caller.abort();
		await expect(rendering).rejects.toBe(caller.signal.reason);
		const result = await storage.cleanup({ dryRun: false });
		expect(result.kept).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					category: "noise-reduction",
					reason: "In use by a running job",
				}),
				expect.objectContaining({
					category: "temporary-renders",
					reason: "In use by a running job",
				}),
			]),
		);
		expect(await readFile(output, "utf8")).toBe("partial render");
		expect(await readFile(idle, "utf8")).toBe("1234");
	} finally {
		finished.resolve();
		await reducer.stop();
	}
	expect(await storage.cleanup({ dryRun: false })).toMatchObject({
		freedBytes: 4,
	});
});

test("holds one runtime lock per root and releases it for a restart", async () => {
	const { root, storage } = await setup();
	await mkdir(join(root, "Cache"));
	const release = lockRoot({ root });
	try {
		expect(() => lockRoot({ root })).toThrow("Splice is already using");
		expect(await storage.cleanup({ dryRun: false })).toMatchObject({
			freedBytes: 0,
			kept: [{ category: "Cache", reason: "Splice runtime state" }],
		});
	} finally {
		release();
	}
	lockRoot({ root })();
});

const ffmpeg = Bun.which("ffmpeg");

test.skipIf(!ffmpeg)(
	"RPC cleanup lets pause scans, loudness and denoised media rebuild",
	async () => {
		const { root } = await setup();
		await mkdir(join(root, "Footage"));
		const generated = Bun.spawnSync([
			ffmpeg ?? "ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			join(root, "Footage", "take.wav"),
		]);
		expect(generated.exitCode).toBe(0);

		const token = "test-token";
		const server = startServer({ root, token, port: 0, upstream: null });
		const rpc = createRpcClient({ origin: server.origin, token });
		const params = { path: "take.wav" };
		try {
			for (const method of [
				"pauses.detect",
				"loudness.measure",
				"noiseReduction.render",
			]) {
				expect(await rpc({ method, params })).toMatchObject({ cached: false });
				expect(await rpc({ method, params })).toMatchObject({ cached: true });
			}
			const denoised = new URL(
				denoisedAudioUrlForPath(params.path),
				server.origin,
			);
			const headers = { authorization: `Bearer ${token}`, range: "bytes=0-99" };
			const before = await fetch(denoised, { headers });
			expect(before.status).toBe(206);
			const bytes = await before.bytes();
			expect(bytes).toHaveLength(100);

			const report = storageReportSchema.parse(
				await rpc({ method: "storage.report" }),
			);
			expect(report).toMatchObject({ dryRun: true, freedBytes: 0, errors: [] });
			expect(report.reclaimableBytes).toBeGreaterThan(0);

			const response = await fetch(new URL(BRIDGE_PATHS.api, server.origin), {
				method: "POST",
				headers: { origin: server.origin, authorization: `Bearer ${token}` },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "storage.cleanup",
					params: { dryRun: false },
				}),
			});
			expect(await response.json()).toMatchObject({
				id: 1,
				result: {
					dryRun: false,
					freedBytes: report.reclaimableBytes,
					errors: [],
				},
			});

			for (const method of ["pauses.detect", "loudness.measure"])
				expect(await rpc({ method, params })).toMatchObject({ cached: false });
			const after = await fetch(denoised, { headers });
			expect(after.status).toBe(206);
			expect(await after.bytes()).toEqual(bytes);
			expect(
				await rpc({ method: "noiseReduction.render", params }),
			).toMatchObject({ cached: true });
		} finally {
			await server.stop();
		}
	},
);
