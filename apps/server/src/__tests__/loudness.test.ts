import { expect, test } from "bun:test";
import { RPC_ERRORS } from "@splice/bridge";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoudnessMeter,
	ebur128Args,
	loudnessCacheKey,
	loudnessGain,
	PEAK_READING_MARGIN_DB,
	parseEbur128Summary,
	planSourceGains,
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
	expect(() => parseEbur128Summary("Conversion failed!")).toThrow(
		"no loudness summary",
	);
});

test("measures only the selected source ranges, as dual mono, on the transcript timeline", () => {
	const args = ebur128Args({
		source: "Footage/take 1.mov",
		ranges: [
			{ start: 0.5, end: 2.25 },
			{ start: 3, end: 5.5 },
		],
	});
	expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 4)).toEqual([
		"-i",
		"Footage/take 1.mov",
		"-map",
		"0:a:0",
	]);
	expect(args[args.indexOf("-af") + 1]).toBe(
		"aresample=async=1:first_pts=0,asetnsamples=n=480:p=0,aselect='gte(t,0.500000)*lt(t,2.250000)+gte(t,3.000000)*lt(t,5.500000)',ebur128=peak=true:dualmono=true:framelog=verbose",
	);
	expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
	const whole = ebur128Args({ source: "a.wav", ranges: null });
	expect(whole[whole.indexOf("-af") + 1]).toBe(
		"aresample=async=1:first_pts=0,ebur128=peak=true:dualmono=true:framelog=verbose",
	);
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
				{ start: 0, end: 3 },
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
		for (const path of ["../secret.wav", "notes.txt", "missing.wav"]) {
			await expect(meter.measure({ path })).rejects.toMatchObject({
				code: RPC_ERRORS.INVALID_PARAMS,
			});
		}
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
				clipIds: ["a", "b"],
				ranges: [{ start: 0, end: 4 }],
			},
			{
				projectItemId: "browser",
				path: null,
				clipIds: ["c"],
				ranges: [{ start: 0, end: 1 }],
			},
			{
				projectItemId: "silent",
				path: "silent.wav",
				clipIds: ["d"],
				ranges: [{ start: 0, end: 1 }],
			},
		],
		measure: async (request) => {
			measured.push(request);
			return request.path === "quiet.wav"
				? { integratedLufs: -28, truePeakDbtp: -12.5, lraLu: 5 }
				: { integratedLufs: null, truePeakDbtp: null, lraLu: 0 };
		},
	});
	expect(measured).toEqual([
		{ path: "quiet.wav", ranges: [{ start: 0, end: 4 }] },
		{ path: "silent.wav", ranges: [{ start: 0, end: 1 }] },
	]);
	expect(plan.sourceGains).toEqual([
		{ projectItemId: "quiet", gainDb: 11.45 },
	]);
	expect(plan.sources.map((source) => "skipped" in source)).toEqual([
		false,
		true,
		true,
	]);
	expect(plan.sources[0]).toMatchObject({
		gain: { gainDb: 11.45, limitedBy: "true_peak", expectedLufs: -16.5 },
	});
});
