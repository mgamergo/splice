import { createCacheUse, type CacheUse } from "./cache-use";
import { RPC_ERRORS, isFootagePath, type Transcript } from "@splice/bridge";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	footageContentHash,
	mediaTypeForPath,
	resolveFootagePath,
	versionForStats,
} from "./footage";
import { BridgeError } from "./tab-bridge";
import { type FileIdentity, fileIdentity } from "./file-identity";
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
export const expectedRecordingVersion = z.string().min(1).nullable().optional();
const wordsSchema = z.union([
	z.strictObject(transcriptWordsInput),
	z.strictObject({
		recordings: z
			.array(
				z.strictObject({
					path: footagePath,
					expectedVersion: z.string().min(1).nullable(),
				}),
			)
			.min(1)
			.max(200),
	}),
]);
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

/**
 * Keyed on the recording's whole identity, so a file replaced with one of the
 * same size and modified time isn't given the old file's word times.
 */
export function transcriptCacheKey({
	path,
	info,
	model,
	content,
}: {
	content?: string;
	path: string;
	info: FileIdentity;
	model: string;
}): string {
	// Bump the version when cached transcript semantics change.
	return createHash("sha256")
		.update(
			JSON.stringify([
				4,
				...(content ? [content] : [path, ...fileIdentity(info)]),
				model,
			]),
		)
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

export type RecordingRequest = {
	path: string;
	expectedVersion?: string | null;
};

/** Check a project binding using filesystem metadata before touching analysis. */
export async function locateRecording({
	root,
	path,
	expectedVersion,
}: RecordingRequest & { root: string }) {
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
	const info = await stat(source);
	const version = versionForStats(info);
	if (expectedVersion !== undefined && expectedVersion !== version)
		throw invalidParams(
			`The recording changed on disk or has not been verified: ${path}. Verify or relink it in the project first.`,
		);
	return { source, info, version };
}

/** The full digest keys analysis shared across locations and file versions. */
export async function resolveRecording({
	signal,
	...request
}: RecordingRequest & { root: string; signal?: AbortSignal }) {
	const located = await locateRecording(request);
	const content = await footageContentHash({
		absolutePath: located.source,
		version: located.version,
		signal,
	});
	return { ...located, content };
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
	cacheUse = createCacheUse(),
	createTools = createWhisperTools,
}: {
	root: string;
	cacheUse?: CacheUse;
	extract?: typeof extractAudio;
	createTools?: typeof createWhisperTools;
}) {
	const stop = new AbortController();
	const signal = stop.signal;
	const tools = createTools({ root, signal });
	const cacheDir = join(root, "Cache", "transcripts");
	const jobs = new Map<string, Job>();
	const active = new Map<string, Job>();

	async function identifySource({
		path,
		expectedVersion,
		signal: caller,
	}: RecordingRequest & { signal?: AbortSignal }) {
		const { source, info, content, version } = await resolveRecording({
			root,
			path,
			expectedVersion,
			signal: caller ? AbortSignal.any([signal, caller]) : signal,
		});
		const model = await identifyModel({ root });
		const inputs = { path, info, model: model.fingerprint };
		const key = transcriptCacheKey({ ...inputs, content });
		const legacy = transcriptCacheKey(inputs);
		return {
			source,
			model,
			key,
			version,
			cachePath: join(cacheDir, `${key}.json`),
			legacyPath: join(cacheDir, `${legacy}.json`),
		};
	}

	async function readCurrentCache({
		cachePath,
		legacyPath,
	}: Awaited<ReturnType<typeof identifySource>>) {
		const cached = await readCache({ cachePath });
		if (cached) return cached;
		return cacheUse.use({
			cache: "transcripts",
			operation: async () => {
				if (!(await readCache({ cachePath: legacyPath })))
					return readCache({ cachePath });
				// Both cache files live on the same volume. Linking publishes the complete file.
				await link(legacyPath, cachePath).catch(() => {});
				return readCache({ cachePath });
			},
		});
	}

	async function transcribe({
		job,
		source,
		model,
		key,
		version,
	}: {
		job: Job;
		source: string;
		model: Model;
		key: string;
		version: string;
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
			if (
				current.key !== key ||
				current.source !== source ||
				current.version !== version
			) {
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

	async function result({
		job,
		page,
		path = job.path,
	}: {
		job: Job;
		page: PageInput;
		path?: string;
	}) {
		const base = { jobId: job.id, path, ...job.state };
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
				path,
				segments: page.includeWords
					? selection
					: selection.map(({ start, end, text }) => ({ start, end, text })),
			},
			totalSegments: segments.length,
			nextOffset: next < segments.length ? next : null,
		};
	}

	/** The cached transcript for a Footage path, or null if it hasn't been transcribed. */
	async function cached({
		path,
		expectedVersion,
		signal,
	}: RecordingRequest & {
		signal?: AbortSignal;
	}): Promise<Transcript | null> {
		const cached = await readCurrentCache(
			await identifySource({ path, expectedVersion, signal }),
		);
		if (expectedVersion !== undefined)
			await locateRecording({ root, path, expectedVersion });
		return cached && { ...cached, path };
	}

	return {
		cached,

		async start(params: unknown) {
			const parsed = startSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { path, waitSeconds = 0, ...page } = parsed.data;
			const identity = await identifySource({ path });
			const { source, model, key, version, cachePath } = identity;
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
				created.ready = readCurrentCache(identity).then((cached) => {
					if (cached) created.state = { status: "completed", cached: true };
				});
				created.finished = created.ready
					.then(async () => {
						if (created.state.status === "completed") return;
						try {
							const backend = await cacheUse.use({
								cache: "transcripts",
								operation: () =>
									transcribe({ job: created, source, model, key, version }),
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
			return result({ job, page, path });
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
				const identity = await identifySource({ path });
				const { cachePath, key } = identity;
				const job =
					active.get(key) ??
					Array.from(jobs.values())
						.reverse()
						.find((item) => item.cachePath === cachePath);
				if (job) return result({ job, page, path });
				if (await readCurrentCache(identity)) {
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
		async words({ params, signal }: { params: unknown; signal?: AbortSignal }) {
			const parsed = wordsSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const transcripts: Array<{
				path: string;
				words: Array<{ start: number; end: number; text: string }>;
			}> = [];
			const missing: string[] = [];
			const scoped = "recordings" in parsed.data;
			const recordings: RecordingRequest[] =
				"recordings" in parsed.data
					? parsed.data.recordings
					: Array.from(new Set(parsed.data.paths), (path) => ({ path }));
			for (const { path, expectedVersion } of recordings) {
				const read = () => cached({ path, expectedVersion, signal });
				// Project reads must fail before any results can be attached.
				const transcript = scoped
					? await read()
					: await read().catch(() => null);
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
