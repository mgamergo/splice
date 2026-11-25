/**
 * Times what the creator waits for: a Horizontal export of a long recording
 * and the final mix's loudness measure, in a real browser against a real
 * `splice`. Also records how long the page's main thread stalls meanwhile.
 *
 *   bun run bench [--minutes 5 | --seconds 20] [--chrome <path>] [--headed]
 *                 [--skip-mix] [--skip-export] [--profile] [--scrub]
 *
 * Needs FFmpeg on PATH and `bun run build:web` first. Results print as JSON
 * and append to bench/results.jsonl, so runs on different machines compare.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	appendFileSync,
	copyFileSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { tmpdir, cpus, totalmem, hostname } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
};

const repo = resolve(import.meta.dir, "..");
const seconds = option("seconds")
	? Number(option("seconds"))
	: Number(option("minutes") ?? 5) * 60;
const port = Number(option("port") ?? 7499);
const chrome =
	option("chrome") ??
	process.env.SPLICE_BENCH_CHROME ??
	[
		"/usr/bin/chromium",
		"/usr/bin/google-chrome",
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
	].find((path) => existsSync(path));
if (!chrome) throw new Error("Pass --chrome <path to Chrome or Chromium>.");

const cache = join(repo, "bench", ".cache");
mkdirSync(cache, { recursive: true });

/** Camera-like footage: 1080p30 H.264 with a 250-frame GOP and AAC speech-band audio. */
function fixture(): string {
	const path = join(cache, `recording-${seconds}s.mp4`);
	if (existsSync(path)) return path;
	console.error(`Encoding a ${seconds}-second 1080p30 fixture…`);
	const result = spawnSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=220:sample_rate=48000:duration=${seconds}`,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"28",
			"-pix_fmt",
			"yuv420p",
			"-g",
			"250",
			"-c:a",
			"aac",
			"-b:a",
			"160k",
			"-ac",
			"2",
			"-movflags",
			"+faststart",
			`${path}.part.mp4`,
		],
		{ stdio: "inherit" },
	);
	if (result.status !== 0)
		throw new Error("FFmpeg failed to encode the fixture.");
	copyFileSync(`${path}.part.mp4`, path);
	return path;
}

const recording = fixture();
const root = join(tmpdir(), `splice-bench-${process.pid}`);
mkdirSync(join(root, "Footage", "Bench clips"), { recursive: true });
copyFileSync(recording, join(root, "Footage", "Bench clips", "recording.mp4"));

const server = spawn("bun", [join(repo, "apps/server/src/cli.ts")], {
	cwd: repo,
	env: { ...process.env, SPLICE_ROOT: root, SPLICE_PORT: String(port) },
	stdio: ["ignore", "pipe", "inherit"],
});
const link = await new Promise<string>((resolveLink, reject) => {
	let output = "";
	server.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/projects#\S+/);
		if (match) resolveLink(match[0]);
	});
	server.on("exit", (code) => reject(new Error(`splice exited with ${code}`)));
});
const token = new URL(link).hash.split("=")[1];
const origin = new URL(link).origin;

let rpcId = 1;
async function rpc(method: string, params?: unknown): Promise<any> {
	const response = await fetch(`${origin}/splice/rpc`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
	});
	const body = (await response.json()) as {
		result?: unknown;
		error?: { message: string };
	};
	if (body.error) throw new Error(`${method}: ${body.error.message}`);
	return body.result;
}

const browser = await chromium.launch({
	executablePath: chrome,
	headless: !flag("headed"),
	args: [
		"--enable-unsafe-webgpu",
		"--enable-features=Vulkan",
		"--ignore-gpu-blocklist",
		"--autoplay-policy=no-user-gesture-required",
	],
});
const results: Record<string, unknown> = {
	date: new Date().toISOString(),
	host: hostname(),
	cpus: cpus().length,
	memoryGb: Math.round(totalmem() / 2 ** 30),
	chrome,
	commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo })
		.stdout.toString()
		.trim(),
	seconds,
};

try {
	const page = await browser.newPage({
		viewport: { width: 1600, height: 900 },
	});
	page.on("console", (message) => {
		if (message.type() === "error") console.error(`[page] ${message.text()}`);
	});
	await page.addInitScript(() => {
		localStorage.setItem("splice:bench", "1");
		// The longest the main thread went without running a 50 ms timer.
		const stalls: number[] = [];
		let last = performance.now();
		setInterval(() => {
			const now = performance.now();
			stalls.push(now - last - 50);
			last = now;
		}, 50);
		Object.assign(window, { __benchStalls: stalls });
	});
	await page.goto(link);
	const projectId = await page.waitForFunction(
		async () => {
			const editor = (window as any).__spliceEditor;
			return editor ? editor.project.createNewProject({ name: "Bench" }) : null;
		},
		undefined,
		{ timeout: 60_000 },
	);
	await page.goto(`${origin}/editor/${await projectId.jsonValue()}`);
	await page.waitForFunction(
		() => (window as any).__spliceEditor?.project.getActiveOrNull?.(),
		undefined,
		{ timeout: 60_000 },
	);
	// The tab bridge connects once the editor has a project.
	for (let attempt = 0; ; attempt++) {
		try {
			await rpc("editor.getState");
			break;
		} catch (error) {
			if (attempt > 60) throw error;
			await Bun.sleep(500);
		}
	}

	const imported = await rpc("editor.importItems", {
		paths: ["Bench clips/recording.mp4"],
	});
	if (imported.failed.length) throw new Error(JSON.stringify(imported.failed));
	const itemIds = imported.imported.map((item: { id: string }) => item.id);
	const state = await rpc("editor.getState");
	await rpc("editor.rawSequence", {
		expectedRevision: state.revision,
		projectItemIds: itemIds,
	});

	await page.evaluate(() => {
		(window as any).__benchStalls.length = 0;
	});
	if (flag("scrub")) {
		results.scrub = await page.evaluate(async (fixtureSeconds: number) => {
			const editor = (window as any).__spliceEditor;
			const Cache = (window as any).__spliceVideoCache;
			const item = editor.media.getProjectItems()[0];
			// Late in each 250-frame GOP: the worst case for an exact seek.
			const targets = [7.9, 24.5, 41.1, 57.8, 16.2, 49.4].filter(
				(time) => time < fixtureSeconds,
			);
			const run = async (keyFrameFirst: boolean) => {
				const cache = new Cache();
				const read = (time: number) =>
					cache.getFrameAt({ mediaId: item.id, file: item.file, time, keyFrameFirst });
				await read(0);
				const firstMs: number[] = [];
				const exactMs: number[] = [];
				for (const time of targets) {
					const started = performance.now();
					let frame = await read(time);
					firstMs.push(performance.now() - started);
					while (frame && !(time >= frame.timestamp && time < frame.timestamp + frame.duration))
						frame = await read(time);
					exactMs.push(performance.now() - started);
				}
				cache.clearAll();
				const mean = (values: number[]) =>
					Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
				return { firstFrameMs: mean(firstMs), exactFrameMs: mean(exactMs) };
			};
			return { exact: await run(false), keyFrameFirst: await run(true) };
		}, seconds);
		console.error(`Scrub: ${JSON.stringify(results.scrub)}`);
	}

	if (!flag("skip-export")) {
		const peakMemory = { browserMb: 0 };
		const sampler = setInterval(async () => {
			const browserMb = browserMemoryMb();
			peakMemory.browserMb = Math.max(peakMemory.browserMb, browserMb);
			const progress = await page
				.evaluate(() => (window as any).__spliceEditor.project.getExportState())
				.catch(() => null);
			if (progress)
				console.error(
					`  export ${progress.step ?? ""} ${Math.round(progress.progress * 100)}%  browser ${browserMb} MB`,
				);
		}, 5000);
		const exportProfiler = flag("profile") ? await page.context().newCDPSession(page) : null;
	await exportProfiler?.send("Profiler.enable");
	await exportProfiler?.send("Profiler.setSamplingInterval", { interval: 2000 });
	await exportProfiler?.send("Profiler.start");
	const exported = await page.evaluate(async () => {
			const editor = (window as any).__spliceEditor;
			const marks: Array<[number, number]> = [];
			const started = performance.now();
			const unsubscribe = editor.project.subscribe?.(() => {
				const { progress } = editor.project.getExportState();
				if (!marks.length || progress - marks[marks.length - 1][1] >= 0.05)
					marks.push([(performance.now() - started) / 1000, progress]);
			});
			const result = await editor.project.deliver({
				quality: "high",
				acceptStaleGain: true,
			});
			unsubscribe?.();
			return {
				success: result.success,
				encoder: result.encoder,
				error: result.error,
				failedStep: result.failedStep,
				seconds: (performance.now() - started) / 1000,
				marks,
			};
		});
		clearInterval(sampler);
	if (exportProfiler) {
		const { profile } = await exportProfiler.send("Profiler.stop");
		console.error(`Export profile:\n${summarizeProfile(profile)}`);
	}
		const stalls = await page.evaluate(() =>
			[...(window as any).__benchStalls].sort((a: number, b: number) => b - a),
		);
		const firstRender = exported.marks.find(
			([, progress]: [number, number]) => progress > 0.06,
		);
		results.export = {
			success: exported.success,
			error: exported.error,
			failedStep: exported.failedStep,
			seconds: round(exported.seconds),
			realtimeFactor: round(seconds / exported.seconds),
			secondsBeforeFirstFrames: firstRender ? round(firstRender[0]) : null,
			longestStallMs: Math.round(stalls[0] ?? 0),
			stallsOver200ms: stalls.filter((stall: number) => stall > 200).length,
			peakBrowserMemoryMb: peakMemory.browserMb || null,
			encoder: exported.encoder ?? null,
		};
		results.output = checkOutput();
		console.error(`Export: ${JSON.stringify(results.export)}`);
		console.error(`Output: ${JSON.stringify(results.output)}`);
	}

	if (!flag("skip-mix")) {
		const { sequenceId } = await rpc("editor.getState");
		const profiler = flag("profile") ? await page.context().newCDPSession(page) : null;
		await profiler?.send("Profiler.enable");
		await profiler?.send("Profiler.start");
		const started = performance.now();
		await rpc("editor.mixLoudness", { sequenceId, apply: false });
		results.mixLoudnessSeconds = round((performance.now() - started) / 1000);
		console.error(`Mix loudness: ${results.mixLoudnessSeconds} s`);
		if (profiler) {
			const { profile } = await profiler.send("Profiler.stop");
			console.error(summarizeProfile(profile));
		}
	}
	results.memoryMb = await page.evaluate(() =>
		Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 2 ** 20),
	);
	const gpu = await page.evaluate(async () => {
		const adapter = await (navigator as any).gpu?.requestAdapter({
			powerPreference: "high-performance",
		});
		return adapter
			? `${adapter.info?.vendor} ${adapter.info?.architecture} ${adapter.info?.description}`.trim()
			: "none";
	});
	results.webgpu = gpu;
} finally {
	await browser.close();
	// splice's web host is its child; Windows doesn't end children with it.
	if (process.platform === "win32")
		spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
	else server.kill("SIGINT");
}

console.log(JSON.stringify(results, null, 2));
appendFileSync(
	join(repo, "bench", "results.jsonl"),
	`${JSON.stringify(results)}\n`,
);
process.exit(0);

/**
 * What the export published: its streams and duration, whether the index is
 * at the front, and whether a frame from the middle shows the picture.
 */
function checkOutput() {
	const name = readdirSync(join(root, "Exports"), { recursive: true })
		.map(String)
		.find((entry) => entry.endsWith(".mp4"));
	if (!name) return { found: false };
	const file = join(root, "Exports", name);
	const probe = JSON.parse(
		spawnSync("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"stream=codec_name,sample_rate:format=duration",
			"-of",
			"json",
			file,
		]).stdout.toString(),
	);
	const head = readFileSync(file).subarray(0, 4096).toString("latin1");
	const stats = spawnSync("ffmpeg", [
		"-v",
		"info",
		"-ss",
		String(seconds / 2),
		"-i",
		file,
		"-frames:v",
		"1",
		"-vf",
		"signalstats,metadata=print:key=lavfi.signalstats.YAVG",
		"-f",
		"null",
		"-",
	]);
	const output = `${stats.stdout}${stats.stderr}`;
	return {
		found: true,
		codecs: probe.streams.map((stream: { codec_name: string }) => stream.codec_name),
		audioRate: probe.streams.find((stream: { sample_rate?: string }) => stream.sample_rate)
			?.sample_rate,
		duration: Number(probe.format.duration),
		indexAtFront: head.includes("moov"),
		middleFrameBrightness: Number(output.match(/YAVG=([\d.]+)/)?.[1] ?? -1),
	};
}

/** The main thread's self time by function, heaviest first. */
function summarizeProfile(profile: {
	nodes: Array<{
		id: number;
		callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	}>;
	samples: number[];
	timeDeltas: number[];
}): string {
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));
	const self = new Map<string, number>();
	let total = 0;
	profile.samples.forEach((id, index) => {
		const frame = byId.get(id)?.callFrame;
		const delta = profile.timeDeltas[index] ?? 0;
		total += delta;
		const key = frame
			? `${frame.functionName || "(anonymous)"} ${frame.url.split("/").at(-1)}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
			: "?";
		self.set(key, (self.get(key) ?? 0) + delta);
	});
	return [...self]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 25)
		.map(([key, micros]) => `${((100 * micros) / total).toFixed(1).padStart(5)}%  ${key}`)
		.join("\n");
}

/** Resident memory of every Chrome process, where `ps` can tell (Linux and macOS). */
function browserMemoryMb(): number {
	if (process.platform === "win32") return 0;
	const ps = spawnSync("ps", ["-eo", "rss,comm"]).stdout?.toString() ?? "";
	let kb = 0;
	for (const line of ps.split("\n")) {
		const [rss, command] = line.trim().split(/\s+/, 2);
		if (/chrom/i.test(command ?? "")) kb += Number(rss) || 0;
	}
	return Math.round(kb / 1024);
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
