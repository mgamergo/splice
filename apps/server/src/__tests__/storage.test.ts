import { footageVersion } from "../footage";
import { afterEach, expect, test } from "bun:test";
import { BRIDGE_PATHS, denoisedAudioUrlForPath } from "@splice/bridge";
import { storageReportSchema } from "@splice/bridge/storage";
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promoteCacheFile } from "../cache-promotion";
import { createCacheUse } from "../cache-use";
import { createExportStore } from "../exports";
import { createNoiseReducer } from "../noise-reduction";
import { createRpcClient } from "../rpc-client";
import { lockRoot } from "../root-lock";
import { startServer } from "../server";
import { createStorage } from "../storage";
import { removeStorageEntry } from "../storage-removal";

const roots: string[] = [];
const KEY = "a".repeat(64);
const STAGING_ID = "1c4dcd2e-f635-4d8a-92da-86fc21a16bb8";

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
	async function apply(selection = {}) {
		const { previewToken } = await storage.report(selection);
		return storage.cleanup({ dryRun: false, previewToken });
	}
	return { root, storage, cacheUse, exportStore, save, apply };
}

test("classifies disk data, defaults to dry run, and applies age and category filters", async () => {
	const { root, storage, save, apply } = await setup();
	const pause = await save(`Cache/pauses/${KEY}.json`);
	const loudness = await save(`Cache/loudness/audio-${KEY}.mka`);
	const temporary = await save(
		"Cache/noise-reduction/.job-Ab1234/denoised.wav",
	);
	const abandoned = await save(`Exports/.staging/${STAGING_ID}/mp4`);
	const kept = [
		await save("Footage/original.mov"),
		await save("Footage/approved-graphic.png"),
		await save("Footage/approved-music.wav"),
		await save("Projects/checkpoint.json"),
		await save("Projects/corrected-captions.json"),
		await save("Exports/published/published.mp4"),
		await save("Exports/published/published.srt"),
		await save("Profile/spellings.json"),
		await save("Profile/corrections.jsonl"),
		await save("Profile/style-defaults.json"),
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
		await apply({
			olderThanDays: 1,
			categories: ["pauses", "loudness"],
		}),
	).toMatchObject({ freedBytes: 4, reclaimableBytes: 4, errors: [] });
	await expect(readFile(pause)).rejects.toHaveProperty("code", "ENOENT");
	expect(await readFile(loudness, "utf8")).toBe("1234");

	const applied = await apply();
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

test("reports both names of promoted analysis and recognizes sampled audio intermediates", async () => {
	const { root, storage, save, apply } = await setup();
	const rebuilt = [
		await save(`Cache/loudness/audio-sample-v1-${KEY}.mka`),
		await save(`Cache/loudness/audio-${KEY}.mka`),
	];
	const entries = [
		{
			dir: "pauses",
			extension: "json",
			jobPrefix: ".scan-",
			jobFile: "scan.json",
		},
		{
			dir: "loudness",
			extension: "json",
			jobPrefix: ".job-",
			jobFile: "loudness.json",
		},
		{
			dir: "noise-reduction",
			extension: "wav",
			jobPrefix: ".job-",
			jobFile: "denoised.wav",
		},
	];
	for (const { dir, extension, jobPrefix, jobFile } of entries) {
		const legacy = await save(`Cache/${dir}/${KEY}.${extension}`);
		const target = join(root, "Cache", dir, `${"b".repeat(64)}.${extension}`);
		await promoteCacheFile({ legacy, target, jobPrefix, jobFile });
		expect(await readFile(target, "utf8")).toBe(await readFile(legacy, "utf8"));
		expect((await lstat(legacy)).nlink).toBe(1);
		expect((await lstat(target)).nlink).toBe(1);
		rebuilt.push(legacy, target);
	}
	const kept = [
		await save("Cache/loudness/audio-sample-v1-unknown.mka"),
		await save(`Cache/transcripts/${KEY}.json`),
	];
	expect(await storage.report({})).toMatchObject({ reclaimableBytes: 32 });
	expect(await apply()).toMatchObject({ freedBytes: 32, errors: [] });
	for (const path of rebuilt)
		await expect(readFile(path)).rejects.toHaveProperty("code", "ENOENT");
	for (const path of kept) expect(await readFile(path, "utf8")).toBe("1234");
});

test("preserves links, their protected targets, and files shared with original recordings", async () => {
	const { root, apply, save } = await setup();
	const original = await save("Projects/checkpoint.json");
	const hardLink = join(root, "Cache", "pauses", `${KEY}.json`);
	const aliasTarget = await save(`Cache/noise-reduction/${KEY}.wav`);
	const staged = await save(`Exports/.staging/${STAGING_ID}/mp4`);
	await mkdir(dirname(hardLink), { recursive: true });
	await link(original, hardLink);
	await symlink(dirname(aliasTarget), join(root, "Footage"), "junction");
	await symlink(original, join(dirname(staged), "link"), "file");
	await symlink(dirname(original), join(root, "Cache", "loudness"), "junction");

	const result = await apply();
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
	const { apply, exportStore, save } = await setup();
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
	const stale = await save(`Exports/.staging/${STAGING_ID}/mp4`);
	const begun = await exportStore.begin(request);
	if (!("exportId" in begun)) throw new Error("Expected a reservation.");
	await exportStore.write({
		...begun,
		kind: "mp4",
		offset: 0,
		body: new Response("video").body,
	});
	const result = await apply();
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
	expect(await apply()).toMatchObject({
		freedBytes: 0,
	});
});

test("protects shared work after its last caller disconnects and until the job settles", async () => {
	const { root, apply, cacheUse, save } = await setup();
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
		const result = await apply();
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
	expect(await apply()).toMatchObject({
		freedBytes: 4,
	});
});

test("keeps unknown lookalike cache and export staging data", async () => {
	const { save, apply } = await setup();
	const known = await save("Cache/loudness/.audio-Ab12c3/audio.mka");
	const kept = [
		await save(`Cache/loudness/${KEY}.json/personal-data`),
		await save("Cache/noise-reduction/.job-Xy1234/manual.wav"),
		await save("Cache/noise-reduction/.job-not-an-app-job/denoised.wav"),
		await save("Exports/.staging/manual.txt"),
		await save("Exports/.staging/manual/mp4"),
		await save(`Exports/.staging/${STAGING_ID}/mp4`),
		await save(`Exports/.staging/${STAGING_ID}/manual.txt`),
		await save(`Exports/.staging/${crypto.randomUUID()}`),
	];

	const result = await apply();
	expect(result).toMatchObject({ freedBytes: 4, errors: [] });
	expect(result.kept).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ reason: "Unrecognized cache data" }),
			expect.objectContaining({ reason: "Unrecognized export staging data" }),
		]),
	);
	await expect(readFile(known)).rejects.toHaveProperty("code", "ENOENT");
	for (const path of kept) expect(await readFile(path, "utf8")).toBe("1234");
});

test("keeps the original and outside files when a managed ancestor becomes a junction", async () => {
	const { root, storage, save } = await setup();
	const managed = await save(`Cache/pauses/${KEY}.json`);
	const outside = await save(`Profile/${KEY}.json`);
	const preview = await storage.report({});
	expect(preview.reclaimableBytes).toBe(4);

	const moved = join(root, "moved");
	await rename(dirname(managed), moved);
	await symlink(dirname(outside), dirname(managed), "junction");

	const result = await storage.cleanup({
		dryRun: false,
		previewToken: preview.previewToken,
	});
	expect(result.freedBytes).toBe(0);
	expect(await readFile(outside, "utf8")).toBe("1234");
	expect(await readFile(join(moved, `${KEY}.json`), "utf8")).toBe("1234");
});

test.skipIf(process.platform === "win32")(
	"stops when a job ancestor is swapped after deletion starts",
	async () => {
		const { root, save } = await setup();
		const dir = "Cache/transcripts/.job-Ab1234";
		const wav = await save(`${dir}/audio.wav`);
		const draft = await save(`${dir}/whisper.json`);
		const outside = await save("Profile/.job-Ab1234/whisper.json");
		const moved = join(root, "moved");
		const snapshot = async (path: string) => ({
			path,
			info: await lstat(path),
		});
		const ancestors = await Promise.all(
			[root, join(root, "Cache"), join(root, "Cache/transcripts")].map(
				snapshot,
			),
		);
		const entry = await snapshot(join(root, dir));
		const files = await Promise.all([wav, draft].map(snapshot));

		expect(() =>
			removeStorageEntry({
				ancestors,
				entry,
				files,
				onRemove() {
					renameSync(join(root, "Cache/transcripts"), moved);
					symlinkSync(
						join(root, "Profile"),
						join(root, "Cache/transcripts"),
						"junction",
					);
				},
			}),
		).toThrow("could not be safely opened");
		expect(await readFile(outside, "utf8")).toBe("1234");
		expect(
			await readFile(join(moved, ".job-Ab1234/whisper.json"), "utf8"),
		).toBe("1234");
	},
);

test("keeps a scanned job when files are added inside its directory", async () => {
	const { storage, save } = await setup();
	const pending = await save("Cache/noise-reduction/.job-Ab1234/denoised.wav");
	const preview = await storage.report({});
	expect(preview.reclaimableBytes).toBe(4);
	const added = await save("Cache/noise-reduction/.job-Ab1234/nested/new.wav");

	const result = await storage.cleanup({
		dryRun: false,
		previewToken: preview.previewToken,
	});
	expect(result.freedBytes).toBe(0);
	for (const path of [pending, added])
		expect(await readFile(path, "utf8")).toBe("1234");
});

test("applies only unchanged entries from the confirmed preview and reports new candidates", async () => {
	const { storage, cacheUse, save } = await setup();
	const pause = await save(`Cache/pauses/${KEY}.json`);
	const changed = await save(`Cache/pauses/${"b".repeat(64)}.json`);
	const excluded = await save(`Cache/loudness/${KEY}.json`);
	const release = await cacheUse.acquire("noise-reduction");
	const preview = await storage.report({});
	expect(preview.categories).toContainEqual(
		expect.objectContaining({
			category: "noise-reduction",
			items: 0,
		}),
	);
	release();
	const fresh = await save(`Cache/noise-reduction/${KEY}.wav`);
	await writeFile(changed, "changed");
	const newPause = await save(`Cache/pauses/${"c".repeat(64)}.json`);

	const params = {
		dryRun: false,
		previewToken: preview.previewToken,
		categories: ["pauses"],
	};
	await expect(storage.cleanup({ dryRun: false })).rejects.toThrow(
		"fresh storage preview",
	);
	expect(await storage.cleanup(params)).toMatchObject({
		freedBytes: 4,
		newOrChangedItems: 3,
		errors: [],
	});
	await expect(storage.cleanup(params)).rejects.toThrow(
		"fresh storage preview",
	);
	await expect(readFile(pause)).rejects.toHaveProperty("code", "ENOENT");
	expect(await readFile(changed, "utf8")).toBe("changed");
	for (const path of [fresh, excluded, newPause])
		expect(await readFile(path, "utf8")).toBe("1234");
});

test("holds one runtime lock per root and releases it for a restart", async () => {
	const { root, apply } = await setup();
	await mkdir(join(root, "Cache"));
	const release = lockRoot({ root });
	try {
		expect(() => lockRoot({ root })).toThrow("Splice is already using");
		expect(await apply()).toMatchObject({
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
		const params = {
			path: "take.wav",
			expectedVersion: await footageVersion({
				absolutePath: join(root, "Footage", "take.wav"),
			}),
		};
		try {
			for (const method of [
				"pauses.detect",
				"loudness.measure",
				"noiseReduction.render",
			]) {
				expect(await rpc({ method, params })).toMatchObject({ cached: false });
				expect(await rpc({ method, params })).toMatchObject({ cached: true });
			}
			for (const method of [
				"pauses.detect",
				"loudness.measure",
				"noiseReduction.render",
			])
				await expect(
					rpc({
						method,
						params: { ...params, expectedVersion: "old-version" },
					}),
				).rejects.toThrow("recording changed on disk");
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
					params: { dryRun: false, previewToken: report.previewToken },
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
