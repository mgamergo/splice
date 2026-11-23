import { describe, expect, test } from "bun:test";
import {
	denoisedAudioUrlForPath,
	mediaUrlForPath,
	RPC_ERRORS,
} from "@splice/bridge";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLoudnessMeter, loudnessCacheKey } from "../loudness";
import {
	createNoiseReducer,
	denoiseArgs,
	NOISE_WINDOW_SECONDS,
	noiseScanArgs,
	parseNoiseScanLine,
	pickNoiseWindow,
	type RenderDenoised,
	sampledDenoiseFilter,
} from "../noise-reduction";
import { startServer } from "../server";

async function withRoot(run: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "splice-denoise-"));
	try {
		await mkdir(join(root, "Footage", "Day 1"), { recursive: true });
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("reads each window's RMS level from FFmpeg's metadata log", () => {
	expect(
		parseNoiseScanLine(
			"[Parsed_ametadata_3 @ 0x5581] lavfi.astats.Overall.RMS_level=-48.815289",
		),
	).toBe(-48.815289);
	expect(parseNoiseScanLine("lavfi.astats.Overall.RMS_level=-inf")).toBe(
		-Infinity,
	);
	expect(parseNoiseScanLine("frame:3    pts:144000  pts_time:3")).toBeNull();
});

test("learns noise from the quietest window, skipping digital silence and the partial last window", () => {
	const speech = -22;
	expect(
		pickNoiseWindow([speech, speech, -51, -55, -Infinity, -95, speech, -70]),
	).toEqual({ start: 3 * NOISE_WINDOW_SECONDS, rmsDb: -55 });
	// No window is clearly quieter than the rest: all talking, or all noise.
	expect(pickNoiseWindow([speech, -25, -24, speech, -30])).toBeNull();
	expect(pickNoiseWindow([-50, -51, -50, -52])).toBeNull();
	expect(pickNoiseWindow([-50])).toBeNull();
});

test("the scan logs one RMS level per window on the source timeline", () => {
	const args = noiseScanArgs({ source: "Footage/take.mov" });
	expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 4)).toEqual([
		"-i",
		"Footage/take.mov",
		"-map",
		"0:a:0",
	]);
	expect(args[args.indexOf("-af") + 1]).toBe(
		"aresample=48000:async=1:first_pts=0,asetnsamples=n=48000:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level",
	);
});

test("samples the noise profile from the window, then renders the whole recording as WAV", () => {
	const args = denoiseArgs({
		source: "in.mov",
		output: "out.wav",
		window: { start: 42, rmsDb: -55 },
	});
	// The window is read by its own seeked input, so nothing buffers.
	expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual([
		"-ss",
		"42.000000",
	]);
	expect(args.filter((arg) => arg === "-i")).toHaveLength(2);
	expect(args.filter((arg) => arg === "-protocol_whitelist")).toHaveLength(2);
	expect(args[args.indexOf("-filter_complex") + 1]).toBe(
		"[0:a:0]atrim=duration=1.000000,asetpts=PTS-STARTPTS[noise];" +
			"[1:a:0]aresample=async=1:first_pts=0[recording];" +
			"[noise][recording]concat=n=2:v=0:a=1,highpass=f=80:poles=2,highpass=f=80:poles=2," +
			"asendcmd=c='0 afftdn sn start;1.000000 afftdn sn stop',afftdn=nr=20:nf=-55," +
			"atrim=start=1.000000,asetpts=PTS-STARTPTS[out]",
	);
	expect(args.slice(-6)).toEqual([
		"-c:a",
		"pcm_s16le",
		"-f",
		"wav",
		"-y",
		"out.wav",
	]);

	const tracked = denoiseArgs({
		source: "in.mov",
		output: "o.wav",
		window: null,
	});
	expect(tracked).not.toContain("-ss");
	expect(tracked[tracked.indexOf("-af") + 1]).toBe(
		"aresample=async=1:first_pts=0,highpass=f=80:poles=2,highpass=f=80:poles=2,afftdn=nr=12:nf=-50:tn=1",
	);
});

describe("noise reducer", () => {
	test("renders once per file into Cache, never touching Footage, and again when the file changes", () =>
		withRoot(async (root) => {
			const footage = join(root, "Footage", "Day 1", "take.wav");
			await writeFile(footage, "source audio");
			const renders: string[] = [];
			const render: RenderDenoised = async ({ source, output }) => {
				renders.push(source);
				await Bun.sleep(20);
				await writeFile(output, `denoised ${await Bun.file(source).text()}`);
				return { noiseWindow: { start: 3, rmsDb: -52 } };
			};
			const reducer = createNoiseReducer({ root, render });
			const [first, joined] = await Promise.all([
				reducer.ensure({ path: "Day 1/take.wav" }),
				reducer.ensure({ path: "Day 1/take.wav" }),
			]);
			expect(joined).toBe(first);
			expect(first).toMatchObject({
				cached: false,
				noiseWindow: { start: 3, rmsDb: -52 },
			});
			expect(first.file).toStartWith(join(root, "Cache", "noise-reduction"));
			expect(first.file).toEndWith(".wav");
			expect(await Bun.file(first.file).text()).toBe("denoised source audio");
			expect(await Bun.file(footage).text()).toBe("source audio");
			// No temporary job folders are left behind.
			expect(await readdir(join(root, "Cache", "noise-reduction"))).toEqual([
				basename(first.file),
			]);

			expect(await reducer.render({ path: "Day 1/take.wav" })).toEqual({
				path: "Day 1/take.wav",
				cached: true,
			});
			expect(renders).toHaveLength(1);

			await utimes(footage, new Date(), new Date(Date.now() + 10_000));
			expect(await reducer.render({ path: "Day 1/take.wav" })).toEqual({
				path: "Day 1/take.wav",
				cached: false,
				noiseProfile: { sampledAt: 3, rmsDb: -52 },
			});
			expect(renders).toHaveLength(2);
			await reducer.stop();
		}));

	test("reports a tracked profile when no quiet stretch was found, and refuses non-recordings", () =>
		withRoot(async (root) => {
			await writeFile(join(root, "Footage", "talk.wav"), "audio");
			await writeFile(join(root, "Footage", "still.png"), "image");
			const reducer = createNoiseReducer({
				root,
				render: async ({ output }) => {
					await writeFile(output, "denoised");
					return { noiseWindow: null };
				},
			});
			expect(await reducer.render({ path: "talk.wav" })).toMatchObject({
				noiseProfile: "tracked",
			});
			for (const path of ["still.png", "../talk.wav", "missing.wav"])
				await expect(reducer.render({ path })).rejects.toMatchObject({
					code: RPC_ERRORS.INVALID_PARAMS,
				});
		}));

	test("a failed render leaves no cache entry", () =>
		withRoot(async (root) => {
			await writeFile(join(root, "Footage", "take.wav"), "audio");
			let fail = true;
			const reducer = createNoiseReducer({
				root,
				render: async ({ output }) => {
					await writeFile(output, "partial");
					if (fail) throw new Error("ffmpeg exited with 1");
					return { noiseWindow: null };
				},
			});
			await expect(reducer.ensure({ path: "take.wav" })).rejects.toThrow(
				"ffmpeg exited",
			);
			expect(await readdir(join(root, "Cache", "noise-reduction"))).toEqual([]);
			fail = false;
			expect(await reducer.ensure({ path: "take.wav" })).toMatchObject({
				cached: false,
			});
		}));
});

test("sets afftdn's noise floor to the sampled stretch's level, within its range", () => {
	expect(sampledDenoiseFilter({ start: 0, rmsDb: -45.8 })).toBe(
		"afftdn=nr=20:nf=-46",
	);
	expect(sampledDenoiseFilter({ start: 0, rmsDb: -88 })).toBe(
		"afftdn=nr=20:nf=-80",
	);
	expect(sampledDenoiseFilter({ start: 0, rmsDb: -12 })).toBe(
		"afftdn=nr=20:nf=-20",
	);
});

test("loudness with noise reduction on measures the render, cached apart from the source", () =>
	withRoot(async (root) => {
		await writeFile(join(root, "Footage", "take.wav"), "source");
		const rendered = join(root, "Cache", "noise-reduction", "x.wav");
		const ensured: string[] = [];
		const measured: string[] = [];
		const meter = createLoudnessMeter({
			root,
			noiseReduction: {
				ensure: async ({ path }) => {
					ensured.push(path);
					return { file: rendered, cached: true };
				},
			},
			measure: async ({ source }) => {
				measured.push(source);
				return source === rendered
					? { integratedLufs: -21.5, truePeakDbtp: -9, lraLu: 3 }
					: { integratedLufs: -21, truePeakDbtp: -8, lraLu: 3 };
			},
		});
		const ranges = [{ start: 0, end: 4 }];
		expect(
			await meter.measure({ path: "take.wav", ranges, noiseReduction: true }),
		).toMatchObject({ noiseReduction: true, integratedLufs: -21.5 });
		expect(await meter.measure({ path: "take.wav", ranges })).toMatchObject({
			noiseReduction: false,
			integratedLufs: -21,
		});
		expect(
			await meter.measure({ path: "take.wav", ranges, noiseReduction: true }),
		).toMatchObject({ cached: true, integratedLufs: -21.5 });
		expect(ensured).toEqual(["take.wav"]);
		expect(measured).toHaveLength(2);
		expect(measured[0]).toBe(rendered);
		expect(measured[1]).toEndWith(join("Footage", "take.wav"));

		const identity = { path: "a.wav", size: 1, mtimeMs: 2, ranges: null };
		// Keys measured before noise reduction existed stay valid.
		expect(loudnessCacheKey({ ...identity, noiseReduction: false })).toBe(
			loudnessCacheKey(identity),
		);
		expect(loudnessCacheKey({ ...identity, noiseReduction: true })).not.toBe(
			loudnessCacheKey(identity),
		);
		await meter.stop();
	}));

const ffmpeg = Bun.which("ffmpeg");

async function ffmpegLog(args: string[]): Promise<string> {
	const child = Bun.spawn(
		[ffmpeg ?? "ffmpeg", "-nostdin", "-hide_banner", ...args],
		{
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const log = await new Response(child.stderr).text();
	if ((await child.exited) !== 0) throw new Error(log);
	return log;
}

/** RMS level in dBFS of a stretch of a file, from FFmpeg's astats. */
async function rmsDb({
	file,
	start,
	end,
}: {
	file: string;
	start: number;
	end: number;
}): Promise<number> {
	const log = await ffmpegLog([
		"-i",
		file,
		"-af",
		`atrim=${start}:${end},astats=measure_perchannel=none:measure_overall=RMS_level`,
		"-f",
		"null",
		"-",
	]);
	const match = /RMS level dB:\s+(-inf|-?\d+(?:\.\d+)?)/.exec(log)?.[1];
	if (!match) throw new Error(log);
	return match === "-inf" ? -Infinity : Number(match);
}

async function integratedLufs(file: string): Promise<number> {
	const log = await ffmpegLog([
		"-i",
		file,
		"-af",
		"ebur128",
		"-f",
		"null",
		"-",
	]);
	return Number(
		/I:\s+(-?\d+(?:\.\d+)?) LUFS/.exec(
			log.slice(log.lastIndexOf("Summary:")),
		)?.[1],
	);
}

/**
 * 12 s of speech-like tones with a gap at 4–8 s, over pink hiss and 60 Hz
 * hum at a home mic's level: a noise floor near -46 dBFS.
 */
async function writeNoisyRecording(file: string) {
	const voice =
		"0.25*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*4*t))*(lt(t,4)+gte(t,8))+0.12*sin(2*PI*540*t)*(lt(t,4)+gte(t,8))";
	await ffmpegLog([
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`aevalsrc='${voice}':s=48000:d=12`,
		"-f",
		"lavfi",
		"-i",
		"anoisesrc=color=pink:amplitude=0.01:sample_rate=48000:seed=7:d=12",
		"-f",
		"lavfi",
		"-i",
		"sine=f=60:sample_rate=48000:d=12",
		"-filter_complex",
		"[2]volume=-30dB[hum];[0][1][hum]amix=inputs=3:normalize=0",
		"-ac",
		"1",
		"-y",
		file,
	]);
}

describe.skipIf(!ffmpeg)("with FFmpeg", () => {
	test(
		"lowers the noise floor in a pause by over 10 dB and keeps the speech and timeline",
		() =>
			withRoot(async (root) => {
				const footage = join(root, "Footage", "Day 1", "take.wav");
				await writeNoisyRecording(footage);
				const before = await Bun.file(footage).bytes();
				const reducer = createNoiseReducer({ root });
				const { file, noiseWindow } = await reducer.ensure({
					path: "Day 1/take.wav",
				});
				// The profile comes from the pause.
				expect(noiseWindow?.start).toBeGreaterThanOrEqual(4);
				expect(noiseWindow?.start).toBeLessThan(8);
				const gap = { start: 4.5, end: 7.5 };
				const floorBefore = await rmsDb({ file: footage, ...gap });
				const floorAfter = await rmsDb({ file, ...gap });
				expect(floorBefore).toBeGreaterThan(-50);
				expect(floorBefore - floorAfter).toBeGreaterThan(10);
				expect(
					Math.abs(
						(await integratedLufs(file)) - (await integratedLufs(footage)),
					),
				).toBeLessThan(1.5);
				const duration = async (path: string) =>
					Number(
						/Duration: 00:00:(\d+\.\d+)/.exec(
							await ffmpegLog(["-i", path, "-f", "null", "-"]),
						)?.[1],
					);
				expect(await duration(file)).toBeCloseTo(await duration(footage), 2);
				// Raw stays untouched.
				expect(
					createHash("sha256")
						.update(await Bun.file(footage).bytes())
						.digest("hex"),
				).toBe(createHash("sha256").update(before).digest("hex"));
				await reducer.stop();
			}),
		60_000,
	);

	test(
		"the media route serves the denoised WAV with ranges, rendering it on first request",
		() =>
			withRoot(async (root) => {
				await writeNoisyRecording(join(root, "Footage", "Day 1", "take.wav"));
				await writeFile(join(root, "Footage", "still.png"), "image");
				const server = startServer({
					port: 0,
					token: "test-token",
					root,
					upstream: null,
				});
				try {
					const get = ({
						url,
						headers = {},
					}: {
						url: string;
						headers?: Record<string, string>;
					}) =>
						fetch(`${server.origin}${url}`, {
							headers: { authorization: "Bearer test-token", ...headers },
						});
					const url = denoisedAudioUrlForPath("Day 1/take.wav");
					expect(url).toBe(
						`${mediaUrlForPath("Day 1/take.wav")}?audio=denoised`,
					);
					const whole = await get({ url });
					expect(whole.status).toBe(200);
					expect(whole.headers.get("content-type")).toBe("audio/wav");
					const body = new Uint8Array(await whole.arrayBuffer());
					expect(new TextDecoder().decode(body.slice(0, 4))).toBe("RIFF");
					const part = await get({ url, headers: { range: "bytes=0-99" } });
					expect(part.status).toBe(206);
					expect(part.headers.get("content-range")).toBe(
						`bytes 0-99/${body.length}`,
					);
					// Without the query, the source itself is served.
					expect(
						(await get({ url: mediaUrlForPath("Day 1/take.wav") })).headers.get(
							"content-length",
						),
					).toBe(
						String(Bun.file(join(root, "Footage", "Day 1", "take.wav")).size),
					);
					expect(
						(await get({ url: denoisedAudioUrlForPath("still.png") })).status,
					).toBe(400);
					expect((await fetch(`${server.origin}${url}`)).status).toBe(401);
				} finally {
					await server.stop();
				}
			}),
		60_000,
	);
});
