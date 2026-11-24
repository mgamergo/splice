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
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLoudnessMeter, runEbur128 } from "../loudness";
import {
	AFFTDN_LATENCY_SAMPLES,
	createNoiseReducer,
	denoiseArgs,
	denoiseCacheKey,
	extractNoiseProfile,
	NOISE_WINDOW_SECONDS,
	noiseProfileArgs,
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

test("reads each window's RMS level and sample count from FFmpeg's metadata log", () => {
	expect(
		parseNoiseScanLine(
			"[Parsed_ametadata_3 @ 0x5581] lavfi.astats.Overall.RMS_level=-48.815289",
		),
	).toEqual({ rmsDb: -48.815289 });
	expect(parseNoiseScanLine("lavfi.astats.Overall.RMS_level=-inf")).toEqual({
		rmsDb: -Infinity,
	});
	expect(
		parseNoiseScanLine(
			"[Parsed_ametadata_3 @ 0x5581] lavfi.astats.Overall.Number_of_samples=24000.000000",
		),
	).toEqual({ samples: 24000 });
	expect(parseNoiseScanLine("frame:3    pts:144000  pts_time:3")).toBeNull();
});

const full = (rmsDb: number) => ({ rmsDb, samples: 48_000 });

test("learns noise from the quietest window, skipping digital silence and a partial last window", () => {
	const speech = -22;
	expect(
		pickNoiseWindow([
			...[speech, speech, -51, -55, -Infinity, -95, speech].map(full),
			{ rmsDb: -70, samples: 12_000 },
		]),
	).toEqual({ start: 3 * NOISE_WINDOW_SECONDS, rmsDb: -55 });
	// A last window that is whole counts: an exact 4 s recording.
	expect(pickNoiseWindow([-20, -18, -19, -55].map(full))).toEqual({
		start: 3,
		rmsDb: -55,
	});
	// Of two windows, the louder is the reference.
	expect(pickNoiseWindow([-55, -20].map(full))).toEqual({
		start: 0,
		rmsDb: -55,
	});
	// No window is clearly quieter than the rest: all talking, or all noise.
	expect(pickNoiseWindow([speech, -25, -24, speech, -30].map(full))).toBeNull();
	expect(pickNoiseWindow([-50, -51, -50, -52].map(full))).toBeNull();
	expect(pickNoiseWindow([-50, -52].map(full))).toBeNull();
	expect(pickNoiseWindow([-50].map(full))).toBeNull();
});

test("a render is keyed by the file's size, times and inode", () => {
	const info = { size: 10, mtimeMs: 1000, ctimeMs: 1000, ino: 7 };
	const key = denoiseCacheKey({ path: "take.wav", info });
	expect(denoiseCacheKey({ path: "take.wav", info: { ...info } })).toBe(key);
	// Rewritten in place with the size and modified time put back.
	expect(
		denoiseCacheKey({ path: "take.wav", info: { ...info, ctimeMs: 2000 } }),
	).not.toBe(key);
	// Replaced by another file of the same size and times.
	expect(
		denoiseCacheKey({ path: "take.wav", info: { ...info, ino: 8 } }),
	).not.toBe(key);
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
		"aresample=48000:async=1:first_pts=0,asetnsamples=n=48000:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level+Number_of_samples,ametadata=mode=print",
	);
});

test("cuts the noise profile from the scanned timeline, then renders the whole recording after it as WAV", () => {
	const window = { start: 42, rmsDb: -55 };
	const profile = noiseProfileArgs({
		source: "in.mov",
		window,
		output: "noise.wav",
	});
	// Read from the start through the scan's filters, so a timestamp gap
	// shifts the window no differently than it shifted the scan's.
	expect(profile).not.toContain("-ss");
	expect(profile[profile.indexOf("-af") + 1]).toBe(
		"aresample=48000:async=1:first_pts=0,atrim=start_sample=2016000:end_sample=2064000,asetpts=PTS-STARTPTS," +
			"astats=metadata=1:reset=0:measure_perchannel=none:measure_overall=Number_of_samples,ametadata=mode=print",
	);
	expect(profile.slice(-6)).toEqual([
		"-c:a",
		"pcm_f32le",
		"-f",
		"wav",
		"-y",
		"noise.wav",
	]);

	const args = denoiseArgs({
		source: "in.mov",
		output: "out.wav",
		profile: { file: "noise.wav", window },
	});
	expect(args).not.toContain("-ss");
	expect(args.filter((arg) => arg === "-protocol_whitelist")).toHaveLength(2);
	expect(args.filter((arg, index) => args[index - 1] === "-i")).toEqual([
		"noise.wav",
		"in.mov",
	]);
	expect(args[args.indexOf("-filter_complex") + 1]).toBe(
		"[1:a:0]aresample=48000:async=1:first_pts=0[recording];" +
			"[0:a:0][recording]concat=n=2:v=0:a=1,highpass=f=80:poles=2,highpass=f=80:poles=2," +
			"apad=pad_len=1200,asendcmd=c='0 afftdn sn start;1.000000 afftdn sn stop',afftdn=nr=20:nf=-55," +
			"atrim=start_sample=49200,asetpts=PTS-STARTPTS[out]",
	);
	// RF64 past 4 GiB, so long recordings still render.
	expect(args.slice(-8)).toEqual([
		"-c:a",
		"pcm_s16le",
		"-f",
		"wav",
		"-rf64",
		"auto",
		"-y",
		"out.wav",
	]);

	const tracked = denoiseArgs({
		source: "in.mov",
		output: "o.wav",
		profile: null,
	});
	expect(tracked).not.toContain("-ss");
	expect(tracked[tracked.indexOf("-af") + 1]).toBe(
		"aresample=48000:async=1:first_pts=0,highpass=f=80:poles=2,highpass=f=80:poles=2,apad=pad_len=1200,afftdn=nr=12:nf=-50:tn=1,atrim=start_sample=1200,asetpts=PTS-STARTPTS",
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

			// Rewritten with the same size, its modified time put back.
			const { atime, mtime } = await stat(footage);
			await Bun.sleep(10);
			await writeFile(footage, "other audio!");
			await utimes(footage, atime, mtime);
			expect(await reducer.render({ path: "Day 1/take.wav" })).toMatchObject({
				cached: false,
			});
			expect(renders).toHaveLength(3);
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

	test("a recording that leaves Footage before FFmpeg opens it is reported missing, not as FFmpeg's error", () =>
		withRoot(async (root) => {
			const footage = join(root, "Footage", "take.wav");
			await writeFile(footage, "audio");
			const reducer = createNoiseReducer({
				root,
				render: async () => {
					await rm(footage);
					throw new Error("ffmpeg exited with 1.");
				},
			});
			await expect(reducer.render({ path: "take.wav" })).rejects.toMatchObject({
				code: RPC_ERRORS.INVALID_PARAMS,
				data: { missingFootage: true },
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

test("loudness with noise reduction on measures the render, cached apart from the source and by the render", () =>
	withRoot(async (root) => {
		await writeFile(join(root, "Footage", "take.wav"), "source");
		await mkdir(join(root, "Cache", "noise-reduction"), { recursive: true });
		const rendered = join(root, "Cache", "noise-reduction", "x.wav");
		await writeFile(rendered, "loud render");
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
				if (source !== rendered)
					return { integratedLufs: -21, truePeakDbtp: -8, lraLu: 3 };
				return (await Bun.file(rendered).text()) === "loud render"
					? { integratedLufs: -18.8, truePeakDbtp: -6, lraLu: 3 }
					: { integratedLufs: -43.8, truePeakDbtp: -31, lraLu: 3 };
			},
		});
		const ranges = [{ start: 0, end: 4 }];
		expect(
			await meter.measure({ path: "take.wav", ranges, noiseReduction: true }),
		).toMatchObject({ noiseReduction: true, integratedLufs: -18.8 });
		expect(await meter.measure({ path: "take.wav", ranges })).toMatchObject({
			noiseReduction: false,
			integratedLufs: -21,
		});
		expect(
			await meter.measure({ path: "take.wav", ranges, noiseReduction: true }),
		).toMatchObject({ cached: true, integratedLufs: -18.8 });
		expect(new Set(ensured)).toEqual(new Set(["take.wav"]));
		expect(measured).toHaveLength(2);
		expect(measured[0]).toBe(rendered);
		expect(measured[1]).toEndWith(join("Footage", "take.wav"));

		// The render is refreshed 25 dB quieter, with the same size and times.
		const { atime, mtime } = await stat(rendered);
		await Bun.sleep(10);
		await rm(rendered);
		await writeFile(rendered, "soft render");
		await utimes(rendered, atime, mtime);
		expect(
			await meter.measure({ path: "take.wav", ranges, noiseReduction: true }),
		).toMatchObject({ cached: false, integratedLufs: -43.8 });
		expect(measured).toHaveLength(3);
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

/** The file's first channel as 48 kHz samples. */
async function decodeSamples(file: string): Promise<Float32Array> {
	const child = Bun.spawn(
		[
			ffmpeg ?? "ffmpeg",
			"-nostdin",
			"-loglevel",
			"error",
			"-i",
			file,
			"-ac",
			"1",
			"-ar",
			"48000",
			"-f",
			"f32le",
			"-",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const bytes = await new Response(child.stdout).arrayBuffer();
	if ((await child.exited) !== 0)
		throw new Error(await new Response(child.stderr).text());
	return new Float32Array(bytes);
}

/** The loudest sample's index within `around` ± 0.1 s. */
function peakNear({
	samples,
	around,
}: {
	samples: Float32Array;
	around: number;
}): number {
	let peak = around - 4_800;
	const end = Math.min(samples.length, around + 4_800);
	for (let index = peak; index < end; index++)
		if (Math.abs(samples[index]) > Math.abs(samples[peak])) peak = index;
	return peak;
}

/**
 * 12 s of speech-like tones with a gap at 4–8 s, over pink hiss and 60 Hz
 * hum at a home mic's level: a noise floor near -46 dBFS. Clicks, if given,
 * are at those sample indexes.
 */
async function writeNoisyRecording({
	file,
	clicks = [],
}: {
	file: string;
	clicks?: number[];
}) {
	const voice = [
		"0.25*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*4*t))*(lt(t,4)+gte(t,8))+0.12*sin(2*PI*540*t)*(lt(t,4)+gte(t,8))",
		...clicks.map((index) => `0.6*eq(n,${index})`),
	].join("+");
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
		"both renders keep the source's timing and length, compensating afftdn's latency",
		() =>
			withRoot(async (root) => {
				const footage = join(root, "Footage", "take.wav");
				// Near the start and in the last 25 ms, which afftdn would drop.
				const clicks = [6_000, 575_500];
				await writeNoisyRecording({ file: footage, clicks });
				const source = await decodeSamples(footage);
				expect(AFFTDN_LATENCY_SAMPLES).toBe(1_200);
				const window = { start: 5, rmsDb: -46 };
				const file = join(root, "noise.wav");
				await extractNoiseProfile({
					command: ffmpeg ?? "ffmpeg",
					source: footage,
					window,
					output: file,
					signal: new AbortController().signal,
				});
				for (const profile of [null, { file, window }]) {
					const output = join(root, `denoised-${profile ? "sampled" : "tracked"}.wav`);
					await ffmpegLog(denoiseArgs({ source: footage, output, profile }));
					const denoised = await decodeSamples(output);
					expect(denoised.length).toBe(source.length);
					for (const click of clicks)
						expect(peakNear({ samples: denoised, around: click })).toBe(
							peakNear({ samples: source, around: click }),
						);
				}
			}),
		60_000,
	);

	test(
		"a timestamp gap before the quiet stretch keeps the whole recording, and a short profile is refused",
		() =>
			withRoot(async (root) => {
				// 3 s of tone over a faint hiss, with no audio from 2.2 s to 2.9 s.
				// The scan fills the gap with silence, so the window at 2 s is quietest.
				const footage = join(root, "Footage", "gap.mkv");
				await ffmpegLog([
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					"aevalsrc='0.3*sin(2*PI*220*t)*lt(t,2)+0.005*sin(2*PI*3000*t)':s=48000:d=3",
					"-af",
					"asetnsamples=480,aselect='lt(t\\,2.2)+gte(t\\,2.9)'",
					"-c:a",
					"pcm_s16le",
					"-y",
					footage,
				]);
				const reducer = createNoiseReducer({ root });
				const { file, noiseWindow } = await reducer.ensure({ path: "gap.mkv" });
				expect(noiseWindow?.start).toBe(2);
				// Seeking to 2 s would find only 0.3 s of audio before the end.
				expect(await decodeSamples(file)).toHaveLength(3 * 48_000);
				await reducer.stop();

				await expect(
					extractNoiseProfile({
						command: ffmpeg ?? "ffmpeg",
						source: footage,
						window: { start: 2.5, rmsDb: -50 },
						output: join(root, "short.wav"),
						signal: new AbortController().signal,
					}),
				).rejects.toThrow("held 24000 samples, not 48000");
			}),
		60_000,
	);

	test(
		"lowers the noise floor in a pause by over 10 dB and keeps the speech and timeline",
		() =>
			withRoot(async (root) => {
				const footage = join(root, "Footage", "Day 1", "take.wav");
				await writeNoisyRecording({ file: footage });
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
		"loudness with noise reduction measures the render's ranges through the same ffconcat meter",
		() =>
			withRoot(async (root) => {
				await writeNoisyRecording({ file: join(root, "Footage", "take.wav") });
				const reducer = createNoiseReducer({ root });
				const meter = createLoudnessMeter({ root, noiseReduction: reducer });
				// Mostly the pause, where noise reduction changes the most.
				const ranges = [
					{ start: 3, end: 8 },
					{ start: 9, end: 10 },
				];
				const denoised = await meter.measure({
					path: "take.wav",
					ranges,
					noiseReduction: true,
				});
				const source = await meter.measure({ path: "take.wav", ranges });
				const { file } = await reducer.ensure({ path: "take.wav" });
				const signal = new AbortController().signal;
				expect(denoised).toMatchObject(
					await runEbur128({ root, source: file, ranges, signal }),
				);
				expect(source).toMatchObject(
					await runEbur128({
						root,
						source: join(root, "Footage", "take.wav"),
						ranges,
						signal,
					}),
				);
				expect(denoised.integratedLufs).not.toBe(source.integratedLufs);
				await reducer.stop();
				await meter.stop();
			}),
		60_000,
	);

	test(
		"the media route serves the denoised WAV with ranges, rendering it on first request",
		() =>
			withRoot(async (root) => {
				await writeNoisyRecording({
					file: join(root, "Footage", "Day 1", "take.wav"),
				});
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
