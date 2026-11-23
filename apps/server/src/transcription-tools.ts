import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const WHISPER_VERSION = "v1.9.2";
const DEFAULT_MODEL = {
	name: "base.en",
	url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin",
	sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
};
const WINDOWS_BUILDS = {
	cuda: {
		file: "whisper-cublas-12.4.0-bin-x64.zip",
		sha256: "443110ddaad70d4290ab2e77179e31cf712035bbc4fad56bb4519a90c917b39c",
	},
	cpu: {
		file: "whisper-bin-x64.zip",
		sha256: "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a",
	},
};

export interface Model {
	name: string;
	path: string;
	fingerprint: string;
}

export async function identifyModel({
	root,
}: {
	root: string;
}): Promise<Model> {
	const override = process.env.SPLICE_WHISPER_MODEL;
	if (!override) {
		return {
			name: DEFAULT_MODEL.name,
			path: join(
				root,
				"Tools",
				"whisper",
				`ggml-base.en-${DEFAULT_MODEL.sha256.slice(0, 12)}.bin`,
			),
			fingerprint: DEFAULT_MODEL.sha256,
		};
	}
	const path = resolve(override);
	const info = await stat(path).catch(() => null);
	if (!info?.isFile())
		throw new Error(`SPLICE_WHISPER_MODEL is not a file: ${path}`);
	return {
		name: basename(path, ".bin").replace(/^ggml-/, ""),
		path,
		fingerprint: JSON.stringify([path, info.size, info.mtimeMs]),
	};
}

async function download({
	url,
	sha256,
	path,
	signal,
}: {
	url: string;
	sha256: string;
	path: string;
	signal: AbortSignal;
}): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
	});
	if (!response.ok || !response.body) {
		throw new Error(`Download failed (${response.status}): ${url}`);
	}
	const hash = createHash("sha256");
	const checksum = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	await pipeline(
		Readable.from(response.body),
		checksum,
		createWriteStream(path),
		{ signal },
	);
	if (hash.digest("hex") !== sha256)
		throw new Error(`SHA-256 mismatch: ${url}`);
}

export function run({
	command,
	args,
	signal,
	onLine,
}: {
	command: string;
	args: string[];
	signal: AbortSignal;
	onLine?: (line: string) => void;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			signal,
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let tail = "";
		const stderr = createInterface({ input: child.stderr });
		stderr.on("line", (line) => {
			tail = `${tail}\n${line}`.slice(-2500);
			onLine?.(line);
		});
		let failure: Error | undefined;
		child.once("error", (error) => {
			failure = error;
		});
		child.once("close", (code, signal) => {
			stderr.close();
			if (failure) reject(failure);
			else if (code === 0) resolve();
			else
				reject(
					new Error(
						`${basename(command)} exited with ${code ?? signal}.${tail}`,
					),
				);
		});
	});
}

/** Reads only local files in the container formats Footage allows, and maps the first audio stream. */
export function ffmpegInputArgs({ source }: { source: string }): string[] {
	return [
		"-protocol_whitelist",
		"file",
		"-format_whitelist",
		"mov,matroska,webm,wav,mp3,aac,flac,ogg",
		"-i",
		source,
		"-map",
		"0:a:0",
	];
}

export function ffmpegArgs({
	source,
	wav,
}: {
	source: string;
	wav: string;
}): string[] {
	return [
		"-nostdin",
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostats",
		...ffmpegInputArgs({ source }),
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
	];
}

/**
 * Whisper leaves out disfluencies unless its context already has some. A
 * prompt written with them keeps "um" and "uh" in the transcript, so filler
 * words and false starts can be found and cut.
 */
export const DISFLUENCY_PROMPT = "Um, uh, so, erm, I mean, like, ah, okay.";

export function whisperArgs({
	wav,
	output,
	model,
	cpu,
}: {
	wav: string;
	output: string;
	model: Model;
	cpu: boolean;
}): string[] {
	return [
		"-m",
		model.path,
		"-f",
		wav,
		"-l",
		"auto",
		"-ojf",
		"-of",
		output,
		"-pp",
		"--prompt",
		DISFLUENCY_PROMPT,
		...(cpu ? ["-ng"] : []),
	];
}

export async function findFfmpeg({ root }: { root: string }): Promise<string> {
	const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
	const local = join(root, "Tools", name);
	const command = (await Bun.file(local).exists()) ? local : Bun.which(name);
	if (!command)
		throw new Error(
			`Install FFmpeg on PATH or put ${name} in ${join(root, "Tools")}.`,
		);
	return command;
}

export async function extractAudio({
	root,
	source,
	wav,
	signal,
}: {
	root: string;
	source: string;
	wav: string;
	signal: AbortSignal;
}): Promise<number> {
	const command = await findFfmpeg({ root });
	await run({ command, args: ffmpegArgs({ source, wav }), signal });
	const file = await open(wav, "r");
	try {
		const chunkHeader = Buffer.alloc(8);
		const { size } = await file.stat();
		// FFmpeg writes RIFF/WAVE with optional chunks before the PCM data.
		for (let offset = 12; offset + chunkHeader.length <= size; ) {
			const { bytesRead } = await file.read(
				chunkHeader,
				0,
				chunkHeader.length,
				offset,
			);
			if (bytesRead !== chunkHeader.length) break;
			const chunkSize = chunkHeader.readUInt32LE(4);
			offset += chunkHeader.length;
			if (offset + chunkSize > size) break;
			if (chunkHeader.toString("ascii", 0, 4) === "data") {
				if (chunkSize > 0) return chunkSize / (16000 * 2);
				break;
			}
			offset += chunkSize + (chunkSize % 2);
		}
		throw new Error("FFmpeg did not extract any audio.");
	} finally {
		await file.close();
	}
}

/** One in-flight installer per destination. Files become visible after verification. */
export function createWhisperTools({
	root,
	signal,
}: {
	root: string;
	signal: AbortSignal;
}) {
	const dir = join(root, "Tools", "whisper");
	const installs = new Map<string, Promise<void>>();

	async function install({
		destination,
		prepare,
	}: {
		destination: string;
		prepare: (temporary: string) => Promise<string>;
	}): Promise<void> {
		if (await stat(destination).catch(() => null)) return;
		let pending = installs.get(destination);
		if (!pending) {
			pending = (async () => {
				await mkdir(dir, { recursive: true });
				const temporary = await mkdtemp(join(dir, ".install-"));
				try {
					const prepared = await prepare(temporary);
					await rename(prepared, destination);
				} finally {
					await rm(temporary, { force: true, recursive: true });
				}
			})().finally(() => installs.delete(destination));
			installs.set(destination, pending);
		}
		await pending;
	}

	async function ensureModel(model: Model): Promise<void> {
		if (model.fingerprint !== DEFAULT_MODEL.sha256) return;
		await install({
			destination: model.path,
			async prepare(temporary) {
				const path = join(temporary, "model.bin");
				await download({ ...DEFAULT_MODEL, path, signal });
				return path;
			},
		});
	}

	async function windowsBinary(
		variant: keyof typeof WINDOWS_BUILDS,
	): Promise<string> {
		const build = WINDOWS_BUILDS[variant];
		const destination = join(dir, `${WHISPER_VERSION}-${variant}`);
		const binary = join(destination, "whisper-cli.exe");
		await install({
			destination,
			async prepare(temporary) {
				const zip = join(temporary, "whisper.zip");
				await download({
					url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/${build.file}`,
					sha256: build.sha256,
					path: zip,
					signal,
				});
				await run({
					command: "tar.exe",
					args: ["-xf", zip, "-C", temporary],
					signal,
				});
				const executable = join(temporary, "Release", "whisper-cli.exe");
				if (!(await Bun.file(executable).exists()))
					throw new Error("Whisper archive is missing whisper-cli.exe.");
				return dirname(executable);
			},
		});
		return binary;
	}

	return {
		async transcribe({
			model,
			wav,
			output,
			onProgress,
		}: {
			model: Model;
			wav: string;
			output: string;
			onProgress: (percent: number) => void;
		}): Promise<{ value: unknown; backend: "cuda" | "cpu" | "custom" }> {
			await ensureModel(model);
			const runWhisper = async ({
				command,
				cpu,
			}: {
				command: string;
				cpu: boolean;
			}) => {
				let cuda = false;
				await run({
					command,
					args: whisperArgs({ wav, output, model, cpu }),
					signal,
					onLine(line) {
						const progress = /progress =\s*(\d+)%/.exec(line);
						if (progress) onProgress(Number(progress[1]));
						if (/using CUDA\d+ backend/.test(line)) cuda = true;
					},
				});
				const value: unknown = await Bun.file(`${output}.json`).json();
				return { value, cuda };
			};
			const override = process.env.SPLICE_WHISPER_BIN;
			const windows = process.platform === "win32";
			const local = join(dir, windows ? "whisper-cli.exe" : "whisper-cli");
			const command = override
				? resolve(override)
				: (await Bun.file(local).exists())
					? local
					: undefined;
			if (command) {
				const { value, cuda } = await runWhisper({ command, cpu: !windows });
				return { value, backend: cuda ? "cuda" : windows ? "custom" : "cpu" };
			}
			if (!windows || process.arch !== "x64") {
				throw new Error(
					`Install whisper-cli at ${local} or set SPLICE_WHISPER_BIN. See README.md.`,
				);
			}
			try {
				const { value, cuda } = await runWhisper({
					command: await windowsBinary("cuda"),
					cpu: false,
				});
				if (cuda) return { value, backend: "cuda" };
				// whisper.cpp can select its CPU backend itself if no GPU is present.
				return { value, backend: "cpu" };
			} catch (error) {
				signal.throwIfAborted();
				await rm(`${output}.json`, { force: true });
				try {
					const { value } = await runWhisper({
						command: await windowsBinary("cpu"),
						cpu: true,
					});
					return { value, backend: "cpu" };
				} catch (fallbackError) {
					throw new Error(
						`Whisper CUDA failed: ${String(error)}\nCPU fallback failed: ${String(fallbackError)}`,
					);
				}
			}
		},
	};
}
