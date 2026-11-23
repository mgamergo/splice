import { RPC_ERRORS, isFootagePath, type Transcript } from "@splice/bridge";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { mediaTypeForPath, resolveFootagePath } from "./footage";
import { BridgeError } from "./tab-bridge";
import { normalizeTranscript, transcriptSchema } from "./transcript";
import {
	createWhisperTools,
	extractAudio,
	identifyModel,
	type Model,
} from "./transcription-tools";

export const footagePath = z
	.string()
	.refine(isFootagePath, "Use a relative path from footage_list");
export const transcriptPageInput = {
	includeWords: z.boolean().optional(),
	offset: z.number().int().min(0).optional(),
	limit: z.number().int().min(1).max(200).optional(),
};
export const transcribeInput = {
	path: footagePath,
	waitSeconds: z.number().min(0).max(30).optional(),
	...transcriptPageInput,
};
export const transcribeStatusInput = {
	jobId: z.string().min(1).optional(),
	path: footagePath.optional(),
	...transcriptPageInput,
};

export const transcriptWordsInput = {
	paths: z.array(footagePath).min(1).max(200),
};

const startSchema = z.object(transcribeInput);
const wordsSchema = z.object(transcriptWordsInput);
const statusSchema = z.object(transcribeStatusInput);
type PageInput = z.infer<z.ZodObject<typeof transcriptPageInput>>;

type Backend = "cuda" | "cpu" | "custom";
type JobState =
	| { status: "running"; stage: "preparing" | "whisper"; progress: number }
	| { status: "completed"; cached: boolean; backend?: Backend }
	| { status: "failed"; error: string };

type Job = {
	id: string;
	path: string;
	cachePath: string;
	state: JobState;
	ready: Promise<void>;
	finished: Promise<void>;
};

export function transcriptCacheKey({
	path,
	size,
	mtimeMs,
	model,
}: {
	path: string;
	size: number;
	mtimeMs: number;
	model: string;
}): string {
	// Bump the version when cached transcript semantics change.
	return createHash("sha256")
		.update(JSON.stringify([3, path, size, mtimeMs, model]))
		.digest("hex");
}

async function readCache({
	cachePath,
}: {
	cachePath: string;
}): Promise<Transcript | null> {
	try {
		const value: unknown = await Bun.file(cachePath).json();
		const parsed = transcriptSchema.safeParse(value);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function invalidParams(message: string): BridgeError {
	return new BridgeError({ code: RPC_ERRORS.INVALID_PARAMS, message });
}

/** Error data for a recording that isn't in Footage, so callers can skip it. */
export const MISSING_FOOTAGE = { missingFootage: true } as const;

/** A video or audio file under Footage, with what identifies its contents. */
export async function resolveRecording({
	root,
	path,
}: {
	root: string;
	path: string;
}) {
	const type = mediaTypeForPath(path);
	const isRecording = type?.startsWith("audio/") || type?.startsWith("video/");
	const source = await resolveFootagePath({ root, path });
	if (!source || !isRecording) {
		throw new BridgeError({
			code: RPC_ERRORS.INVALID_PARAMS,
			message: `Expected an existing video or audio file under Footage: ${path}`,
			data: isRecording ? MISSING_FOOTAGE : undefined,
		});
	}
	return { source, info: await stat(source) };
}

async function waitFor({
	finished,
	seconds,
}: {
	finished: Promise<void>;
	seconds: number;
}) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			finished,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, seconds * 1000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export function createTranscriptionJobs({
	root,
	extract = extractAudio,
	createTools = createWhisperTools,
}: {
	root: string;
	extract?: typeof extractAudio;
	createTools?: typeof createWhisperTools;
}) {
	const stop = new AbortController();
	const signal = stop.signal;
	const tools = createTools({ root, signal });
	const cacheDir = join(root, "Cache", "transcripts");
	const jobs = new Map<string, Job>();
	const active = new Map<string, Job>();

	async function identifySource({ path }: { path: string }) {
		const { source, info } = await resolveRecording({ root, path });
		const model = await identifyModel({ root });
		const key = transcriptCacheKey({
			path,
			size: info.size,
			mtimeMs: info.mtimeMs,
			model: model.fingerprint,
		});
		return { source, model, key, cachePath: join(cacheDir, `${key}.json`) };
	}

	async function transcribe({
		job,
		source,
		model,
		key,
	}: {
		job: Job;
		source: string;
		model: Model;
		key: string;
	}): Promise<Backend> {
		await mkdir(cacheDir, { recursive: true });
		const temporary = await mkdtemp(join(cacheDir, ".job-"));
		try {
			const wav = join(temporary, "audio.wav");
			const output = join(temporary, "whisper");
			const durationSeconds = await extract({ root, source, wav, signal });
			job.state = { status: "running", stage: "whisper", progress: 0 };
			let progress = 0;
			const { value, backend } = await tools.transcribe({
				model,
				wav,
				output,
				onProgress(percent) {
					progress = Math.min(99, Math.max(progress, percent));
					job.state = { status: "running", stage: "whisper", progress };
				},
			});
			const transcript = normalizeTranscript({
				value,
				path: job.path,
				model: model.name,
				durationSeconds,
			});
			const current = await identifySource({ path: job.path });
			if (current.key !== key || current.source !== source) {
				throw new Error(
					"Footage or the Whisper model changed during transcription. Start a new job.",
				);
			}
			signal.throwIfAborted();
			const pending = join(temporary, "transcript.json");
			await Bun.write(pending, JSON.stringify(transcript));
			await rename(pending, job.cachePath);
			return backend;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	function remember(job: Job) {
		jobs.set(job.id, job);
		if (jobs.size <= 128) return;
		for (const [id, previous] of jobs) {
			if (previous.state.status === "running") continue;
			jobs.delete(id);
			if (jobs.size <= 128) break;
		}
	}

	async function result({ job, page }: { job: Job; page: PageInput }) {
		const base = { jobId: job.id, path: job.path, ...job.state };
		if (base.status !== "completed") return base;
		const transcript = await readCache({ cachePath: job.cachePath });
		if (!transcript) {
			return {
				jobId: job.id,
				path: job.path,
				status: "failed",
				error: "The cached transcript is unavailable. Start a new job.",
			};
		}
		const { segments, ...metadata } = transcript;
		const offset = page.offset ?? 0;
		const selection = segments.slice(offset, offset + (page.limit ?? 100));
		const next = offset + selection.length;
		return {
			...base,
			progress: 100,
			cachePath: job.cachePath,
			transcript: {
				...metadata,
				segments: page.includeWords
					? selection
					: selection.map(({ start, end, text }) => ({ start, end, text })),
			},
			totalSegments: segments.length,
			nextOffset: next < segments.length ? next : null,
		};
	}

	return {
		async start(params: unknown) {
			const parsed = startSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { path, waitSeconds = 0, ...page } = parsed.data;
			const { source, model, key, cachePath } = await identifySource({ path });
			signal.throwIfAborted();
			let job = active.get(key);
			if (!job) {
				const created: Job = {
					id: randomUUID(),
					path,
					cachePath,
					state: { status: "running", stage: "preparing", progress: 0 },
					ready: Promise.resolve(),
					finished: Promise.resolve(),
				};
				created.ready = readCache({ cachePath }).then((cached) => {
					if (cached) created.state = { status: "completed", cached: true };
				});
				created.finished = created.ready
					.then(async () => {
						if (created.state.status === "completed") return;
						try {
							const backend = await transcribe({
								job: created,
								source,
								model,
								key,
							});
							created.state = { status: "completed", cached: false, backend };
						} catch (error) {
							created.state = {
								status: "failed",
								error: error instanceof Error ? error.message : String(error),
							};
						}
					})
					.finally(() => active.delete(key));
				job = created;
				active.set(key, job);
				remember(job);
			}
			await job.ready;
			if (waitSeconds > 0 && job.state.status === "running") {
				await waitFor({ finished: job.finished, seconds: waitSeconds });
			}
			return result({ job, page });
		},

		async status(params: unknown) {
			const parsed = statusSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { jobId, path, ...page } = parsed.data;
			if (Boolean(jobId) === Boolean(path))
				throw invalidParams("Provide either jobId or path.");
			if (jobId) {
				const job = jobs.get(jobId);
				if (job) return result({ job, page });
			}
			if (path) {
				const { cachePath, key } = await identifySource({ path });
				const job =
					active.get(key) ??
					Array.from(jobs.values())
						.reverse()
						.find((item) => item.cachePath === cachePath);
				if (job) return result({ job, page });
				if (await readCache({ cachePath })) {
					const cached: Job = {
						id: randomUUID(),
						path,
						cachePath,
						state: { status: "completed", cached: true },
						ready: Promise.resolve(),
						finished: Promise.resolve(),
					};
					remember(cached);
					return result({ job: cached, page });
				}
			}
			throw invalidParams(
				"No transcription job found. Start one with transcribe.",
			);
		},

		/** Word timings from cached transcripts. Never starts a job; uncached paths are listed as missing. */
		async words(params: unknown) {
			const parsed = wordsSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const transcripts: Array<{
				path: string;
				words: Array<{ start: number; end: number; text: string }>;
			}> = [];
			const missing: string[] = [];
			for (const path of new Set(parsed.data.paths)) {
				// An unreadable or non-media path just has no words.
				const transcript = await identifySource({ path })
					.then(({ cachePath }) => readCache({ cachePath }))
					.catch(() => null);
				if (!transcript) {
					missing.push(path);
					continue;
				}
				transcripts.push({
					path,
					words: transcript.segments.flatMap(({ words }) =>
						words.map(({ start, end, text }) => ({ start, end, text })),
					),
				});
			}
			return { transcripts, missing };
		},

		async stop() {
			stop.abort();
			await Promise.all(Array.from(active.values(), (job) => job.finished));
		},
	};
}
