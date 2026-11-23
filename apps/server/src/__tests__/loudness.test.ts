import { expect, test } from "bun:test";
import { RPC_ERRORS } from "@splice/bridge";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoudnessMeter,
	ebur128Args,
	ebur128Graph,
	loudnessCacheKey,
	loudnessGain,
	MAX_REPEATED_SECONDS,
	MissingFootageError,
	PEAK_READING_MARGIN_DB,
	parseEbur128Summary,
	planSourceGains,
	playedSegments,
	runEbur128,
} from "../loudness";

const fixture = (name: string) =>
	Bun.file(join(import.meta.dir, "fixtures", name)).text();

test("reads integrated loudness, LRA and true peak from FFmpeg's ebur128 summary", async () => {
	expect(parseEbur128Summary(await fixture("ebur128-summary.txt"))).toEqual({
		integratedLufs: -38.7,
		truePeakDbtp: -38.1,
		lraLu: 0,
	});
});

test("reports nothing measured when no audio passes the gate", async () => {
	// FFmpeg reads an empty selection as -70 LUFS with a 0 dBFS peak.
	expect(parseEbur128Summary(await fixture("ebur128-empty.txt"))).toEqual({
		integratedLufs: null,
		truePeakDbtp: null,
		lraLu: 0,
	});
	// Audio under 400 ms never passes the gate, but its peak is real.
	const short = (await fixture("ebur128-summary.txt"))
		.replace("-38.7 LUFS", "-70.0 LUFS")
		.replace("-38.1 dBFS", "-0.2 dBFS");
	expect(parseEbur128Summary(short)).toEqual({
		integratedLufs: null,
		truePeakDbtp: -0.2,
		lraLu: 0,
	});
	expect(() => parseEbur128Summary("Conversion failed!")).toThrow(
		"no loudness summary",
	);
});

test("splits the source where ranges start and end, counting repeats", () => {
	expect(
		playedSegments([
			{ start: 0.5, end: 2.25 },
			{ start: 3, end: 5.5 },
			{ start: 5.5, end: 6 },
		]),
	).toEqual([
		{ start: 0, end: 0.5, copies: 0 },
		{ start: 0.5, end: 2.25, copies: 1 },
		{ start: 2.25, end: 3, copies: 0 },
		{ start: 3, end: 6, copies: 1 },
	]);
	expect(
		playedSegments([
			{ start: 0, end: 2 },
			{ start: 1, end: 3 },
			{ start: 1, end: 3 },
		]),
	).toEqual([
		{ start: 0, end: 1, copies: 1 },
		{ start: 1, end: 2, copies: 3 },
		{ start: 2, end: 3, copies: 2 },
	]);
	// Long repeats are measured in turns, so FFmpeg never holds much of a copy.
	const long = 2.5 * MAX_REPEATED_SECONDS;
	expect(
		playedSegments([
			{ start: 0, end: long },
			{ start: 0, end: long },
		]),
	).toEqual([
		{ start: 0, end: MAX_REPEATED_SECONDS, copies: 2 },
		{ start: MAX_REPEATED_SECONDS, end: 2 * MAX_REPEATED_SECONDS, copies: 2 },
		{ start: 2 * MAX_REPEATED_SECONDS, end: long, copies: 2 },
	]);
});

test("measures the ranges back to back, as dual mono, on the transcript timeline", () => {
	expect(
		ebur128Graph([
			{ start: 0.5, end: 2.25 },
			{ start: 3, end: 4 },
			{ start: 3, end: 4 },
		]).split("\n"),
	).toEqual([
		"[0:a:0]aresample=async=1:first_pts=0,asegment=timestamps=0.500000|2.250000|3.000000|4.000000[s0][s1][s2][s3][s4];",
		"[s4]anullsink;",
		"[s0]anullsink;",
		"[s2]anullsink;",
		"[s3]asplit=2[s3c0][s3c1];",
		"[s1][s3c0][s3c1]concat=n=3:v=0:a=1,ebur128=peak=true:dualmono=true:framelog=verbose[out]",
	]);
	expect(ebur128Graph(null)).toBe(
		"[0:a:0]aresample=async=1:first_pts=0,ebur128=peak=true:dualmono=true:framelog=verbose[out]",
	);
	// The graph goes in a file, so the command stays short however many ranges.
	const args = ebur128Args({
		source: "Footage/take 1.mov",
		graphFile: "Cache/loudness/graph.txt",
		graphFileOption: "-/filter_complex",
	});
	expect(args.slice(args.indexOf("-i"))).toEqual([
		"-i",
		"Footage/take 1.mov",
		"-/filter_complex",
		"Cache/loudness/graph.txt",
		"-map",
		"[out]",
		"-f",
		"null",
		"-",
	]);
});

test("gains reach the target loudness", () => {
	expect(
		loudnessGain({
			measurement: { integratedLufs: -28, truePeakDbtp: -20, lraLu: 4 },
		}),
	).toEqual({
		gainDb: 14,
		expectedLufs: -14,
		expectedTruePeakDbtp: -6,
		limitedBy: null,
	});
	expect(
		loudnessGain({
			measurement: { integratedLufs: -9.5, truePeakDbtp: -2, lraLu: 4 },
			targetLufs: -16,
		}),
	).toMatchObject({ gainDb: -6.5, expectedLufs: -16, limitedBy: null });
});

test("caps the gain so the true peak stays at or below -1 dBTP", () => {
	const capped = loudnessGain({
		measurement: { integratedLufs: -18, truePeakDbtp: -3.37, lraLu: 6 },
	});
	expect(capped).toEqual({
		gainDb: 2.32,
		expectedLufs: -15.7,
		expectedTruePeakDbtp: -1.1,
		limitedBy: "true_peak",
	});
	// A peak already above the cap is brought down even if that lowers loudness.
	expect(
		loudnessGain({
			measurement: { integratedLufs: -20, truePeakDbtp: 0.4, lraLu: 6 },
		}),
	).toMatchObject({ gainDb: -1.45, limitedBy: "true_peak" });
	// Neither FFmpeg's 0.1 dB peak reading nor rounding the gain lifts the
	// real peak over the cap.
	for (const truePeakDbtp of [-4.123, -7.0049, -2.0001, -4.3]) {
		const gain = loudnessGain({
			measurement: { integratedLufs: -30, truePeakDbtp, lraLu: 0 },
		});
		expect(
			truePeakDbtp + PEAK_READING_MARGIN_DB + (gain?.gainDb ?? 0),
		).toBeLessThanOrEqual(-1);
	}
});

test("stays within the clip volume range and skips silence", () => {
	expect(
		loudnessGain({
			measurement: { integratedLufs: -50, truePeakDbtp: -40, lraLu: 0 },
		}),
	).toMatchObject({ gainDb: 20, expectedLufs: -30, limitedBy: "max_gain" });
	expect(
		loudnessGain({
			measurement: { integratedLufs: null, truePeakDbtp: null, lraLu: 0 },
		}),
	).toBeNull();
});

test("audio too short to gate keeps its level unless its peak is over the cap", () => {
	expect(
		loudnessGain({
			measurement: { integratedLufs: null, truePeakDbtp: -0.2, lraLu: 0 },
		}),
	).toEqual({
		gainDb: -0.85,
		expectedLufs: null,
		expectedTruePeakDbtp: -1,
		limitedBy: "true_peak",
	});
	expect(
		loudnessGain({
			measurement: { integratedLufs: null, truePeakDbtp: -12, lraLu: 0 },
		}),
	).toEqual({
		gainDb: 0,
		expectedLufs: null,
		expectedTruePeakDbtp: -12,
		limitedBy: null,
	});
});

test("the cache key covers the file's identity and the measured ranges", () => {
	const input = {
		path: "Day 1/take.mov",
		size: 123,
		mtimeMs: 456.5,
		ranges: [{ start: 1, end: 2 }],
	};
	const key = loudnessCacheKey(input);
	expect(loudnessCacheKey({ ...input })).toBe(key);
	for (const modification of [
		{ path: "Day 1/take 2.mov" },
		{ size: 124 },
		{ mtimeMs: 456.6 },
		{ ranges: [{ start: 1, end: 2.5 }] },
		{ ranges: null },
	]) {
		expect(loudnessCacheKey({ ...input, ...modification })).not.toBe(key);
	}
});

test("measures once per file and ranges, in any order, and remeasures a changed file", async () => {
	const root = await mkdtemp(join(tmpdir(), "splice-loudness-"));
	try {
		await mkdir(join(root, "Footage"));
		const file = join(root, "Footage", "take.wav");
		await writeFile(file, "audio");
		const calls: unknown[] = [];
		const meter = createLoudnessMeter({
			root,
			measure: async ({ ranges }) => {
				calls.push(ranges);
				return { integratedLufs: -20, truePeakDbtp: -6, lraLu: 3 };
			},
		});
		const ranges = [
			{ start: 4, end: 6 },
			{ start: 0, end: 2 },
			{ start: 1.5, end: 3 },
		];
		const [first, joined] = await Promise.all([
			meter.measure({ path: "take.wav", ranges }),
			meter.measure({ path: "take.wav", ranges }),
		]);
		expect(first).toEqual({
			path: "take.wav",
			ranges: [
				{ start: 0, end: 2 },
				{ start: 1.5, end: 3 },
				{ start: 4, end: 6 },
			],
			integratedLufs: -20,
			truePeakDbtp: -6,
			lraLu: 3,
			cached: false,
		});
		expect(joined).toEqual(first);
		expect(
			await meter.measure({ path: "take.wav", ranges: [...ranges].reverse() }),
		).toMatchObject({ integratedLufs: -20, cached: true });
		expect(await meter.measure({ path: "take.wav" })).toMatchObject({
			ranges: null,
			cached: false,
		});
		expect(calls).toHaveLength(2);

		await utimes(file, new Date(), new Date(Date.now() + 10_000));
		expect(await meter.measure({ path: "take.wav", ranges })).toMatchObject({
			cached: false,
		});
		expect(calls).toHaveLength(3);
		await meter.stop();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses paths outside Footage and files that aren't audio or video", async () => {
	const root = await mkdtemp(join(tmpdir(), "splice-loudness-"));
	try {
		await mkdir(join(root, "Footage"));
		await writeFile(join(root, "Footage", "notes.txt"), "text");
		const meter = createLoudnessMeter({
			root,
			measure: () => {
				throw new Error("must not measure");
			},
		});
		for (const path of ["../secret.wav", "notes.txt"]) {
			await expect(meter.measure({ path })).rejects.toMatchObject({
				code: RPC_ERRORS.INVALID_PARAMS,
				data: undefined,
			});
		}
		// A recording that left Footage says so, so normalizing can skip it.
		await expect(meter.measure({ path: "missing.wav" })).rejects.toMatchObject(
			{ code: RPC_ERRORS.INVALID_PARAMS, data: { missingFootage: true } },
		);
		await expect(
			meter.measure({ path: "a.wav", ranges: [{ start: 2, end: 1 }] }),
		).rejects.toMatchObject({ code: RPC_ERRORS.INVALID_PARAMS });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("plans one gain per measurable source and says why others were skipped", async () => {
	const measured: unknown[] = [];
	const plan = await planSourceGains({
		audioSources: [
			{
				projectItemId: "quiet",
				path: "quiet.wav",
				missing: false,
				clipIds: ["a", "b"],
				ranges: [{ start: 0, end: 4 }],
			},
			{
				projectItemId: "browser",
				path: null,
				missing: false,
				clipIds: ["c"],
				ranges: [{ start: 0, end: 1 }],
			},
			{
				projectItemId: "silent",
				path: "silent.wav",
				missing: false,
				clipIds: ["d"],
				ranges: [{ start: 0, end: 1 }],
			},
			{
				projectItemId: "relink",
				path: "relink.wav",
				missing: true,
				clipIds: ["e"],
				ranges: [{ start: 0, end: 1 }],
			},
			{
				projectItemId: "deleted",
				path: "deleted.wav",
				missing: false,
				clipIds: ["f"],
				ranges: [{ start: 0, end: 1 }],
			},
		],
		measure: async (request) => {
			measured.push(request);
			if (request.path === "deleted.wav")
				throw new MissingFootageError("Gone since the editor checked.");
			return request.path === "quiet.wav"
				? { integratedLufs: -28, truePeakDbtp: -12.5, lraLu: 5 }
				: { integratedLufs: null, truePeakDbtp: null, lraLu: 0 };
		},
	});
	expect(measured).toEqual([
		{ path: "quiet.wav", ranges: [{ start: 0, end: 4 }] },
		{ path: "silent.wav", ranges: [{ start: 0, end: 1 }] },
		{ path: "deleted.wav", ranges: [{ start: 0, end: 1 }] },
	]);
	expect(plan.sourceGains).toEqual([{ projectItemId: "quiet", gainDb: 11.45 }]);
	expect(
		plan.sources.map((source) => ("skipped" in source ? source.skipped : null)),
	).toEqual([
		null,
		expect.stringContaining("Stored in the browser"),
		"Silent.",
		expect.stringContaining("Missing from Footage"),
		expect.stringContaining("Missing from Footage"),
	]);
	expect(plan.sources[0]).toMatchObject({
		gain: { gainDb: 11.45, limitedBy: "true_peak", expectedLufs: -16.5 },
	});
});

// Real FFmpeg, on generated audio. Skipped where FFmpeg isn't installed.
const ffmpeg = Bun.which("ffmpeg");

async function ffmpegMeter(callback: (meter: {
	root: string;
	generate: (name: string, expression: string, seconds: number) => Promise<string>;
	measure: (
		source: string,
		ranges: Array<{ start: number; end: number }> | null,
	) => ReturnType<typeof runEbur128>;
	reference: (source: string, filter: string) => Promise<{ lufs: number | null; peak: number | null }>;
}) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "splice-loudness-ffmpeg-"));
	const signal = new AbortController().signal;
	const ffmpegRun = async (args: string[]) => {
		const child = Bun.spawn([ffmpeg ?? "ffmpeg", "-nostdin", "-hide_banner", "-nostats", ...args], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const log = await new Response(child.stderr).text();
		expect(await child.exited).toBe(0);
		return log;
	};
	try {
		await mkdir(join(root, "Footage"));
		await callback({
			root,
			async generate(name, expression, seconds) {
				const file = join(root, "Footage", name);
				await ffmpegRun([
					"-f",
					"lavfi",
					"-i",
					`aevalsrc=${expression}:s=48000:d=${seconds}`,
					"-c:a",
					"pcm_f32le",
					file,
				]);
				return file;
			},
			measure: (source, ranges) => runEbur128({ root, source, ranges, signal }),
			// An independent measurement: trim and join with plain filters.
			async reference(source, filter) {
				const log = await ffmpegRun([
					"-i",
					source,
					"-filter_complex",
					`${filter}ebur128=peak=true:dualmono=true:framelog=verbose[out]`,
					"-map",
					"[out]",
					"-f",
					"null",
					"-",
				]);
				const measured = parseEbur128Summary(log);
				return { lufs: measured.integratedLufs, peak: measured.truePeakDbtp };
			},
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test.skipIf(!ffmpeg)(
	"measures the exact samples a cut keeps, not whole frames around them",
	() =>
		ffmpegMeter(async ({ generate, measure, reference }) => {
			// A loud transient 6 to 9 ms in, just after a cut at 5 ms.
			const source = await generate(
				"boundary.wav",
				"if(between(t\\,0.006\\,0.009)\\,0.9\\,0.025)*sin(2*PI*997*t)",
				2,
			);
			const measured = await measure(source, [{ start: 0.005, end: 1.5 }]);
			const exact = await reference(
				source,
				"[0:a:0]atrim=start=0.005:end=1.5,",
			);
			expect(measured.truePeakDbtp).toBe(exact.peak);
			expect(measured.truePeakDbtp ?? -Infinity).toBeGreaterThan(-2);
			expect(measured.integratedLufs).toBe(exact.lufs);
			// The same cut a sample later leaves the transient out.
			expect(
				(await measure(source, [{ start: 0.0095, end: 1.5 }])).truePeakDbtp,
			).toBeLessThan(-30);
		}),
);

test.skipIf(!ffmpeg)(
	"counts audio once for every clip that plays it",
	() =>
		ffmpegMeter(async ({ generate, measure, reference }) => {
			const source = await generate(
				"repeated.wav",
				"(0.055+0.07*gte(t\\,2))*sin(2*PI*997*t)",
				4,
			);
			const ranges = [
				{ start: 0, end: 2 },
				...Array.from({ length: 8 }, () => ({ start: 2, end: 4 })),
			];
			const measured = await measure(source, ranges);
			const copies = Array.from({ length: 8 }, (_, i) => `[l${i}]`).join("");
			const played = await reference(
				source,
				`[0:a:0]asplit=2[a][b];[a]atrim=end=2[q];[b]atrim=start=2,asplit=8${copies};[q]${copies}concat=n=9:v=0:a=1,`,
			);
			expect(measured.integratedLufs).toBe(played.lufs);
			const once = await measure(source, [{ start: 0, end: 4 }]);
			expect(measured.integratedLufs ?? 0).toBeGreaterThan(
				(once.integratedLufs ?? 0) + 1,
			);
		}),
);

test.skipIf(!ffmpeg)(
	"reports the true peak of audio too short to gate",
	() =>
		ffmpegMeter(async ({ generate, measure }) => {
			const source = await generate("short.wav", "0.98*sin(2*PI*997*t)", 0.25);
			const measured = await measure(source, null);
			expect(measured.integratedLufs).toBeNull();
			expect(measured.truePeakDbtp ?? -Infinity).toBeGreaterThan(-1);
			expect(loudnessGain({ measurement: measured })).toMatchObject({
				limitedBy: "true_peak",
			});
			// Ranges entirely past the end measure nothing at all.
			expect(await measure(source, [{ start: 3, end: 4 }])).toEqual({
				integratedLufs: null,
				truePeakDbtp: null,
				lraLu: 0,
			});
		}),
);

test.skipIf(!ffmpeg)(
	"measures thousands of ranges with a short command line",
	() =>
		ffmpegMeter(async ({ generate, measure, reference }) => {
			const source = await generate("long.wav", "0.1*sin(2*PI*400*t)", 60);
			const ranges = Array.from({ length: 2000 }, (_, i) => ({
				start: i * 0.03,
				end: i * 0.03 + 0.02,
			}));
			const measured = await measure(source, ranges);
			// Cuts fall on whole periods of the tone, so it reads the same however cut.
			const whole = await reference(source, "[0:a:0]");
			expect(measured.integratedLufs ?? 0).toBeCloseTo(whole.lufs ?? 1, 0);
		}),
	60_000,
);
