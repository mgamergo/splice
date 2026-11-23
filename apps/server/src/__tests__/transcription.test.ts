import { expect, test } from "bun:test";
import { RPC_ERRORS } from "@splice/bridge";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcClient } from "../rpc-client";
import { startServer } from "../server";
import { extractAudio, ffmpegArgs, whisperArgs } from "../transcription-tools";
import { createTranscriptionJobs, transcriptCacheKey } from "../transcription";
import { normalizeTranscript } from "../transcript";
import whisperOutput from "./fixtures/whisper-base-en.json";

const source = "Day 1/take #1.m4a";

test("builds shell-free FFmpeg and whisper.cpp arguments", () => {
	const model = { name: "base.en", path: "model path", fingerprint: "base.en" };
	const wav = "working dir/audio.wav";
	expect(ffmpegArgs({ source, wav })).toEqual([
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostats",
		"-progress",
		"pipe:2",
		"-protocol_whitelist",
		"file",
		"-format_whitelist",
		"mov,matroska,webm,wav,mp3,aac,flac,ogg",
		"-i",
		source,
		"-map",
		"0:a:0",
		"-af",
		"aresample=async=1:first_pts=0",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-c:a",
		"pcm_s16le",
		"-f",
		"wav",
		wav,
	]);
	const args = whisperArgs({
		wav,
		output: "working dir/whisper",
		model,
		cpu: false,
	});
	expect(args).toEqual([
		"-m",
		"model path",
		"-f",
		wav,
		"-l",
		"auto",
		"-ojf",
		"-of",
		"working dir/whisper",
		"-pp",
	]);
	expect(
		whisperArgs({ wav, output: "working dir/whisper", model, cpu: true }),
	).toEqual([...args, "-ng"]);
});

test("normalizes full whisper.cpp v1.9.2 JSON captured from synthetic speech", () => {
	const transcript = normalizeTranscript({
		value: whisperOutput,
		path: source,
		model: "base.en",
		durationSeconds: 9.7,
	});
	expect(transcript).toMatchObject({
		path: source,
		model: "base.en",
		language: "en",
		durationSeconds: 9.7,
	});
	const segment = transcript.segments[0];
	expect(segment).toMatchObject({ start: 0, end: 8 });
	expect(segment.words[1]).toEqual({
		start: 0.28,
		end: 0.65,
		text: "blue",
		probability: 0.603236,
	});
	expect(segment.words.map((word) => word.text)).toContain("window,");
	expect(segment.words.at(-1)?.text).toBe("recording.");
	expect(segment.words.some((word) => word.text.startsWith("[_"))).toBe(false);
	expect(() =>
		normalizeTranscript({
			value: {},
			path: source,
			model: "base.en",
			durationSeconds: 9.7,
		}),
	).toThrow();
});

test("cache key includes path, size, mtime and model", () => {
	const input = { path: source, size: 123, mtimeMs: 456.5, model: "base.en" };
	const key = transcriptCacheKey(input);
	expect(transcriptCacheKey({ ...input })).toBe(key);
	for (const modification of [
		{ path: "different.m4a" },
		{ size: 124 },
		{ mtimeMs: 456.6 },
		{ model: "small.en" },
	]) {
		expect(transcriptCacheKey({ ...input, ...modification })).not.toBe(key);
	}
});

test("concurrent requests join one job, then read the full cache and compact pages", async () => {
	const root = await mkdtemp(join(tmpdir(), "splice-transcribe-"));
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let runs = 0;
	const jobs = createTranscriptionJobs({
		root,
		extract: async () => 9.7,
		createTools: () => ({
			async transcribe({ onProgress }) {
				runs++;
				onProgress(42);
				started.resolve();
				await gate.promise;
				return { value: whisperOutput, backend: "cpu" };
			},
		}),
	});
	try {
		await mkdir(join(root, "Footage", "Day 1"), { recursive: true });
		await writeFile(join(root, "Footage", source), "placeholder");
		const [one, two] = await Promise.all([
			jobs.start({ path: source }),
			jobs.start({ path: source }),
		]);
		expect(one.status).toBe("running");
		expect(two.jobId).toBe(one.jobId);
		await started.promise;
		expect(await jobs.status({ path: source })).toMatchObject({
			jobId: one.jobId,
			progress: 42,
		});
		const waiting = jobs.start({
			path: source,
			waitSeconds: 1,
			includeWords: true,
			limit: 1,
		});
		gate.resolve();
		const complete = await waiting;
		expect(complete).toMatchObject({ status: "completed", progress: 100 });
		const cached = await jobs.start({ path: source, limit: 1 });
		expect(runs).toBe(1);
		expect(cached).toMatchObject({ status: "completed", cached: true });
		if (!("transcript" in cached) || !cached.transcript)
			throw new Error("Missing transcript");
		expect(cached.transcript.segments[0]).not.toHaveProperty("words");
		expect(await Bun.file(cached.cachePath).json()).toMatchObject({
			segments: [
				{
					words: expect.arrayContaining([
						expect.objectContaining({ text: "blue" }),
					]),
				},
			],
		});
		await rm(cached.cachePath);
		expect(await jobs.start({ path: source, waitSeconds: 1 })).toMatchObject({
			cached: false,
		});
		expect(runs).toBe(2);
		const recording = join(root, "Footage", source);
		await writeFile(recording, "a different recording");
		await expect(jobs.status({ path: source })).rejects.toMatchObject({
			code: RPC_ERRORS.INVALID_PARAMS,
		});
		expect(await jobs.status({ jobId: cached.jobId })).toMatchObject({
			status: "completed",
		});
	} finally {
		gate.resolve();
		await jobs.stop();
		await rm(root, { force: true, recursive: true });
	}
});

test("transcription RPC refuses traversal, escape symlinks, missing files and images", async () => {
	const root = await mkdtemp(join(tmpdir(), "splice-transcribe-"));
	const token = "test-token";
	const server = startServer({ root, token, port: 0, upstream: null });
	try {
		await mkdir(join(root, "Footage"));
		await writeFile(join(root, "outside.wav"), "");
		await writeFile(join(root, "Footage", "still.png"), "");
		await symlink(
			join(root, "outside.wav"),
			join(root, "Footage", "escape.wav"),
		);
		const rpc = createRpcClient({ origin: server.origin, token });
		for (const path of [
			"../outside.wav",
			"escape.wav",
			"missing.wav",
			"still.png",
		]) {
			await expect(
				rpc({ method: "transcribe.start", params: { path } }),
			).rejects.toMatchObject({ code: RPC_ERRORS.INVALID_PARAMS });
		}
		await expect(
			rpc({
				method: "transcribe.status",
				params: { jobId: "x", path: "still.png" },
			}),
		).rejects.toMatchObject({ code: RPC_ERRORS.INVALID_PARAMS });
	} finally {
		await server.stop();
		await rm(root, { force: true, recursive: true });
	}
});

test("maps Japanese words without spaces to their own tokens", () => {
	const transcript = normalizeTranscript({
		path: source,
		model: "base",
		durationSeconds: 3,
		value: {
			result: { language: "ja" },
			transcription: [
				{
					offsets: { from: 0, to: 3000 },
					text: "猫が好き。",
					tokens: [
						{ text: "猫", p: 0.9, offsets: { from: 0, to: 1000 } },
						{ text: "が", p: 0.9, offsets: { from: 1000, to: 1500 } },
						{ text: "好き", p: 0.9, offsets: { from: 1500, to: 2700 } },
						{ text: "。", p: 0.9, offsets: { from: 2700, to: 3000 } },
					],
				},
			],
		},
	});
	expect(transcript.segments[0].words).toEqual([
		{ text: "猫", start: 0, end: 1, probability: 0.9 },
		{ text: "が", start: 1, end: 1.5, probability: 0.9 },
		{ text: "好き。", start: 1.5, end: 3, probability: 0.9 },
	]);
});

const ffmpeg = Bun.which("ffmpeg");
test.skipIf(!ffmpeg)(
	"preserves leading source time when audio starts after video",
	async () => {
		if (!ffmpeg) throw new Error("FFmpeg is required");
		const root = await mkdtemp(join(tmpdir(), "splice-delayed-audio-"));
		const source = join(root, "delayed.mp4");
		const wav = join(root, "extract.wav");
		try {
			const created = Bun.spawnSync([
				ffmpeg,
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=black:s=16x16:d=3",
				"-itsoffset",
				"2",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=1000:duration=1",
				"-c:v",
				"mpeg4",
				"-c:a",
				"aac",
				source,
			]);
			expect(created.stderr.toString()).toBe("");
			expect(created.exitCode).toBe(0);
			const duration = await extractAudio({
				root,
				source,
				wav,
				signal: AbortSignal.timeout(5000),
			});
			const bytes = Buffer.from(await Bun.file(wav).arrayBuffer());
			let chunk = 12;
			while (
				chunk + 8 <= bytes.length &&
				bytes.toString("ascii", chunk, chunk + 4) !== "data"
			) {
				const size = bytes.readUInt32LE(chunk + 4);
				chunk += 8 + size + (size % 2);
			}
			expect(bytes.toString("ascii", chunk, chunk + 4)).toBe("data");
			const samples = bytes.subarray(
				chunk + 8,
				chunk + 8 + bytes.readUInt32LE(chunk + 4),
			);
			expect(duration).toBeGreaterThan(2.95);
			expect(samples.length / 32000).toBeCloseTo(duration, 3);
			expect(samples.subarray(0, 32000).every((byte) => byte === 0)).toBe(true);
			expect(samples.subarray(2 * 32000).some((byte) => byte !== 0)).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
