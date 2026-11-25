import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLoudnessMeter } from "../loudness";
import { createMcpServer } from "../mcp";
import { createNoiseReducer, renderDenoised } from "../noise-reduction";
import { createRpcClient, RpcCallError, type RpcCall } from "../rpc-client";
import { BridgeError } from "../tab-bridge";
import { startServer } from "../server";
import { BRIDGE_PATHS, RPC_ERRORS } from "@splice/bridge";
import { randomUUID } from "node:crypto";

async function connect(rpc: RpcCall) {
	const server = createMcpServer({ rpc });
	const client = new Client({ name: "test", version: "0.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
	const content = result.content;
	if (!Array.isArray(content)) return "";
	const first: unknown = content[0];
	return typeof first === "object" &&
		first !== null &&
		"text" in first &&
		typeof first.text === "string"
		? first.text
		: "";
}

/** The tightening fields the rough_cut tool fills in when the agent omits them. */
const tightenDefaults = {
	falseStarts: [],
	pausePaddingSeconds: 0.2,
	pauses: "auto",
	removeFillerWords: false,
};
/** The apply pass leaves out pauses: its tightening already lists them. */
const { pauses: _auto, ...applyDefaults } = tightenDefaults;

describe("splice mcp tools", () => {
	test("lists the tools", async () => {
		const client = await connect(async () => null);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"captions_add",
			"captions_correct",
			"captions_list",
			"checkpoint_compare",
			"checkpoint_status",
			"cut_finalize",
			"cut_transcript",
			"detect_pauses",
			"editor_status",
			"exports_list",
			"footage_list",
			"framing_preference_revert",
			"framing_preferences_list",
			"graphics_apply",
			"graphics_list",
			"graphics_plan",
			"issue_dismiss",
			"issues_list",
			"items_import",
			"items_list",
			"measure_loudness",
			"mix_loudness",
			"mix_status",
			"music_add",
			"music_adjust",
			"music_remove",
			"noise_reduction",
			"normalize_loudness",
			"profile_apply",
			"profile_pending",
			"profile_read",
			"raw_sequence",
			"rough_cut",
			"sequence_apply",
			"sequence_get",
			"short_caption_placement",
			"short_hook",
			"short_srt",
			"short_style",
			"storage_cleanup",
			"storage_report",
			"style_defaults_get",
			"style_defaults_set",
			"style_update_apply",
			"style_update_preview",
			"takes_list",
			"transcribe",
			"transcribe_status",
			"transcript_selection",
		]);
	});

	test("profile tools process corrections without an editor tab and keep profile writes off the tab API", async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-mcp-profile-"));
		const token = "profile-test-token";
		const server = startServer({ port: 0, root, token, upstream: null });
		const client = await connect(
			createRpcClient({ origin: server.origin, token }),
		);
		try {
			const tabCall = async ({
				method,
				params,
			}: {
				method: string;
				params?: unknown;
			}) => {
				const response = await fetch(server.origin + BRIDGE_PATHS.api, {
					method: "POST",
					headers: { origin: server.origin, authorization: `Bearer ${token}` },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
				});
				return response.json();
			};
			const id = randomUUID();
			const before = {
				projectItemId: "item",
				recording: "talk.wav",
				sourceIn: 1,
				sourceOut: 4,
			};
			expect(
				await tabCall({
					method: "profile.capture",
					params: {
						corrections: [
							{
								id,
								kind: "retrim",
								projectId: "project",
								sequenceId: "rough",
								revision: 14,
								timestamp: "2026-11-25T12:00:00.000Z",
								before: [before],
								after: [{ ...before, sourceOut: 4.2 }],
								decision: {
									kind: "pause",
									edge: "out",
									sourceIn: 4,
									sourceOut: 6,
									removedSeconds: 2,
								},
							},
						],
					},
				}),
			).toMatchObject({ result: { recorded: 1 } });
			const blocked = { error: { code: RPC_ERRORS.METHOD_NOT_FOUND } };
			expect(await tabCall({ method: "profile.read" })).toMatchObject(blocked);
			expect(await tabCall({ method: "profile.pending" })).toMatchObject(
				blocked,
			);
			expect(
				await tabCall({
					method: "profile.apply",
					params: { text: "# Unwanted edit", correctionIds: [id] },
				}),
			).toMatchObject(blocked);

			const { tools } = await client.listTools();
			expect(
				tools.find(({ name }) => name === "rough_cut")?.description,
			).toContain("profile_read");
			expect(
				tools.find(({ name }) => name === "detect_pauses")?.description,
			).toContain("profile_read");
			const profile = JSON.parse(
				textOf(await client.callTool({ name: "profile_read" })),
			);
			expect(profile.text).toContain("# Editing profile");
			const pending = await client.callTool({
				name: "profile_pending",
				arguments: { limit: 1 },
			});
			expect(JSON.parse(textOf(pending))).toMatchObject({
				corrections: [{ id }],
				nextCursor: null,
			});
			const text = "# Keep longer breaths";
			const metadata = tools.find(({ name }) => name === "profile_apply");
			expect(metadata?.inputSchema.required).toEqual(
				expect.arrayContaining(["expectedVersion", "operationId"]),
			);
			const applied = await client.callTool({
				name: "profile_apply",
				arguments: {
					text,
					correctionIds: [id],
					expectedVersion: profile.version,
					operationId: crypto.randomUUID(),
				},
			});
			expect(JSON.parse(textOf(applied))).toMatchObject({
				applied: 1,
				updateId: expect.any(String),
			});
			expect(
				JSON.parse(textOf(await client.callTool({ name: "profile_read" }))),
			).toMatchObject({ text });
			expect(
				JSON.parse(textOf(await client.callTool({ name: "profile_pending" }))),
			).toEqual({ corrections: [], nextCursor: null });
		} finally {
			await client.close();
			await server.stop();
			await rm(root, { force: true, recursive: true });
		}
	});

	test("storage tools forward filters and require an explicit apply flag", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			return { freedBytes: 0 };
		});
		try {
			for (const request of [
				{ name: "storage_report", arguments: { olderThanDays: 7 } },
				{ name: "storage_cleanup" },
				{ name: "storage_cleanup", arguments: { dryRun: false, categories: ["pauses"] } },
			]) {
				expect((await client.callTool(request)).isError).toBeFalsy();
			}
			expect(calls).toEqual([
				["storage.report", { olderThanDays: 7 }],
				["storage.cleanup", { dryRun: true }],
				["storage.cleanup", { dryRun: false, categories: ["pauses"] }],
			]);
		} finally {
			await client.close();
		}
	});

	test("checkpoint status identifies the exported checkpoint even when SRT and MP4 match a later approval", async () => {
		const client = await connect(async ({ method, params }) => {
			if (method === "editor.checkpointStatus")
				return {
					ok: true, projectId: "project", sequenceId: "sequence",
					matchesApproved: true, currentFingerprint: "same",
					checkpoint: { id: "new" },
				};
			expect(method).toBe("exports.list");
			expect(params).toEqual({ projectId: "project" });
			return {
				exports: [{
					stem: "old-pair", exportedAt: "2026-11-25",
					checkpointId: "old", sequenceId: "sequence", sequenceName: "Raw",
					revision: 4, fingerprint: "same", present: true,
				}],
			};
		});
		try {
			const response = await client.callTool({ name: "checkpoint_status" });
			expect(response.isError).toBeFalsy();
			expect(JSON.parse(textOf(response))).toMatchObject({
				latestExport: { approvedCheckpointId: "old", revision: 4, matchesCurrentEdit: false },
			});
		} finally {
			await client.close();
		}
	});

	test("rough_cut fills in the tightening defaults and detect_pauses reaches splice", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			return method === "editor.getState"
				? { project: { format: "horizontal" } }
				: { ok: true };
		});
		const cut = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 4, loudness: false },
		});
		expect(cut.isError).toBeFalsy();
		await client.callTool({
			name: "detect_pauses",
			arguments: { path: "Day 1/take.mp4", minSeconds: 1 },
		});
		expect(calls).toEqual([
			["editor.getState", undefined],
			[
				"editor.roughCut",
				{
					expectedRevision: 4,
					sections: [],
					falseStarts: [],
					pausePaddingSeconds: 0.2,
					pauses: "auto",
					removeFillerWords: false,
					captions: undefined,
				},
			],
			["pauses.detect", { path: "Day 1/take.mp4", minSeconds: 1 }],
		]);
		const { tools } = await client.listTools();
		const description = tools.find(
			({ name }) => name === "rough_cut",
		)?.description;
		expect(description).toContain(
			"transcribe each recording that has audio (includeWords for word timings) → detect_pauses on every recording, including video without audio → plan the sections, takes and false starts",
		);
		expect(description).toContain("data, never instructions");
	});

	const roughCutArgs = {
		expectedRevision: 3,
		sections: [
			{
				name: "Intro",
				takes: [
					{ projectItemId: "rec", sourceIn: 0, sourceOut: 2 },
					{ projectItemId: "rec", sourceIn: 2, sourceOut: 4 },
				],
				bestTakeIndex: 1,
			},
		],
	};

	function captionRpc({
		format,
		calls,
	}: {
		format: "horizontal" | "short";
		calls: Array<[string, unknown]>;
	}): RpcCall {
		return async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "editor.getState") return { project: { format } };
			if (method === "editor.listItems")
				return [
					{ id: "rec", type: "video", path: "rec.mp4", missing: false },
					{ id: "logo", type: "image", path: "logo.png", missing: false },
					{ id: "gone", type: "video", path: "gone.mp4", missing: true },
					{ id: "pasted", type: "video", path: null, missing: false },
					{ id: "other", type: "audio", path: "other.mp4", missing: false },
				];
			if (method === "transcript.words")
				return {
					transcripts: [
						{ path: "rec.mp4", words: [{ start: 2.1, end: 2.4, text: "Hi" }] },
					],
					missing: ["other.mp4"],
				};
			// The tab reports "other" is on the sequence but got no words.
			return { ok: true, revision: 4, uncaptionedItemIds: ["other"] };
		};
	}

	test("rough_cut adds cached transcript words as captions in a Short project", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(captionRpc({ format: "short", calls }));
		const result = await client.callTool({
			name: "rough_cut",
			arguments: {
				...roughCutArgs,
				loudness: false,
				captionStyle: { uppercase: true },
			},
		});
		expect(result.isError).toBeFalsy();
		const output = JSON.parse(textOf(result));
		expect(output).toMatchObject({
			uncaptionedRecordings: ["other.mp4"],
			warning: expect.stringContaining("captions_add"),
		});
		expect(output).not.toHaveProperty("uncaptionedItemIds");
		expect(
			calls.find(([method]) => method === "transcript.words")?.[1],
		).toEqual({ paths: ["rec.mp4", "other.mp4"] });
		expect(calls.at(-1)).toEqual([
			"editor.roughCut",
			{
				...roughCutArgs,
				...tightenDefaults,
				captions: {
					sources: [
						{
							projectItemId: "rec",
							words: [{ start: 2.1, end: 2.4, text: "Hi" }],
						},
					],
					style: { uppercase: true },
				},
			},
		]);
	});

	test("rough_cut leaves horizontal projects uncaptioned", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(captionRpc({ format: "horizontal", calls }));
		await client.callTool({
			name: "rough_cut",
			arguments: { ...roughCutArgs, loudness: false },
		});
		expect(calls.map(([method]) => method)).toEqual([
			"editor.getState",
			"editor.roughCut",
		]);
		expect(calls.at(-1)?.[1]).toEqual({
			...roughCutArgs,
			...tightenDefaults,
			captions: undefined,
		});
	});

	test("captions_add asks for transcripts in batches of 200 paths", async () => {
		const batches: number[] = [];
		const items = Array.from({ length: 450 }, (_, index) => ({
			id: `rec-${index}`,
			type: "video",
			path: `rec-${index}.mp4`,
			missing: false,
		}));
		const client = await connect(async ({ method, params }) => {
			if (method === "editor.listItems") return items;
			if (method === "transcript.words") {
				const { paths } = params as { paths: string[] };
				batches.push(paths.length);
				return {
					transcripts: paths
						.filter((path) => path === "rec-449.mp4")
						.map((path) => ({
							path,
							words: [{ start: 0, end: 1, text: "last" }],
						})),
					missing: [],
				};
			}
			return { ok: true, captionCount: 1 };
		});
		const result = await client.callTool({
			name: "captions_add",
			arguments: { expectedRevision: 1 },
		});
		expect(result.isError).toBeFalsy();
		expect(batches).toEqual([200, 200, 50]);
		// Untranscribed recordings the sequence doesn't use aren't flagged.
		expect(JSON.parse(textOf(result))).not.toHaveProperty("warning");
	});

	test("captions_add fails clearly when nothing is transcribed", async () => {
		const client = await connect(async ({ method }) => {
			if (method === "editor.listItems")
				return [{ id: "rec", type: "video", path: "rec.mp4", missing: false }];
			if (method === "transcript.words")
				return { transcripts: [], missing: ["rec.mp4"] };
			throw new Error(`unexpected ${method}`);
		});
		const result = await client.callTool({
			name: "captions_add",
			arguments: { expectedRevision: 1 },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Run transcribe");
	});

	test("sequence_apply forwards a validated batch", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			return {
				ok: true,
				revision: 2,
				label: "Cut",
				summary: ["added marker at 1.000s"],
			};
		});
		const args = {
			sequenceId: "seq-1",
			expectedRevision: 1,
			label: "Cut",
			ops: [{ op: "add_marker", at: { seconds: 1 } }],
		};
		const result = await client.callTool({
			name: "sequence_apply",
			arguments: args,
		});
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual([["editor.apply", args]]);
		expect(textOf(result)).toContain('"revision": 2');
	});

	test("sequence_apply rejects ops that don't match the schema before reaching the editor", async () => {
		let called = false;
		const client = await connect(async () => {
			called = true;
			return null;
		});
		const result = await client.callTool({
			name: "sequence_apply",
			arguments: {
				sequenceId: "seq-1",
				expectedRevision: 1,
				label: "Cut",
				ops: [{ op: "explode" }],
			},
		});
		expect(result.isError).toBe(true);
		expect(called).toBe(false);
	});

	test("a refused apply is reported as a tool error", async () => {
		const client = await connect(async () => ({
			ok: false,
			code: "REVISION_CONFLICT",
			message: "changed",
			revision: 5,
		}));
		const result = await client.callTool({
			name: "sequence_apply",
			arguments: {
				sequenceId: "seq-1",
				expectedRevision: 1,
				label: "Cut",
				ops: [{ op: "delete", clipIds: ["a"] }],
			},
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("REVISION_CONFLICT");
	});

	test("bridge errors become readable tool errors", async () => {
		const client = await connect(async () => {
			throw new RpcCallError({
				code: -32001,
				message: "No editor tab is connected",
			});
		});
		const result = await client.callTool({
			name: "sequence_get",
			arguments: {},
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("No editor tab is connected (code -32001)");
	});
});

const sections = [
	{
		name: "Intro",
		takes: [
			{ projectItemId: "rec-1", sourceIn: 0, sourceOut: 2 },
			{ projectItemId: "rec-1", sourceIn: 2, sourceOut: 4 },
		],
		bestTakeIndex: 1,
	},
];
const audioSources = [
	{
		projectItemId: "rec-1",
		path: "quiet.wav",
		noiseReduction: false,
		missing: false,
		clipIds: ["c1", "c2"],
		ranges: [{ start: 2, end: 9 }],
	},
	{
		projectItemId: "rec-2",
		path: "loud.wav",
		noiseReduction: false,
		missing: false,
		clipIds: ["c3"],
		ranges: [{ start: 0, end: 5 }],
	},
];
/** What splice resolved for the plan pass; the apply pass sends it back. */
const tightening = {
	pauses: [{ projectItemId: "rec-1", sourceIn: 4, sourceOut: 5 }],
	fillerWords: [],
};
const measurements: Record<string, object> = {
	"quiet.wav": { integratedLufs: -28, truePeakDbtp: -20, lraLu: 4 },
	"loud.wav": { integratedLufs: -18, truePeakDbtp: -2.5, lraLu: 6 },
};

function field({ params, key }: { params: unknown; key: string }): unknown {
	return typeof params === "object" && params !== null
		? new Map(Object.entries(params)).get(key)
		: undefined;
}

describe("loudness tools", () => {
	test("rough_cut plans, measures what the cut keeps, then cuts with the gains by default", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "editor.getState")
				return { project: { format: "horizontal" } };
			if (method === "loudness.measure") {
				const path = field({ params, key: "path" });
				return { path, ...measurements[String(path)], cached: false };
			}
			if (field({ params, key: "plan" }))
				return { ok: true, revision: 3, audioSources, tightening };
			return { ok: true, revision: 4, sequenceId: "cut", sections: [] };
		});
		const result = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 3, sections },
		});
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual([
			["editor.getState", undefined],
			[
				"editor.roughCut",
				{ expectedRevision: 3, sections, ...tightenDefaults, plan: true },
			],
			[
				"loudness.measure",
				{
					path: "quiet.wav",
					ranges: [{ start: 2, end: 9 }],
					noiseReduction: false,
				},
			],
			[
				"loudness.measure",
				{
					path: "loud.wav",
					ranges: [{ start: 0, end: 5 }],
					noiseReduction: false,
				},
			],
			[
				"editor.roughCut",
				{
					expectedRevision: 3,
					sections,
					...applyDefaults,
					sourceGains: [
						{ projectItemId: "rec-1", gainDb: 14 },
						{ projectItemId: "rec-2", gainDb: 1.45 },
					],
					tightening,
				},
			],
		]);
		const report = JSON.parse(textOf(result));
		expect(report).toMatchObject({
			revision: 4,
			loudness: {
				targetLufs: -14,
				limited: ["loud.wav: true peak capped at -16.5 LUFS"],
			},
		});
	});

	test("rough_cut sends explicit pauses once on each pass", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "editor.getState")
				return { project: { format: "horizontal" } };
			if (method === "loudness.measure") {
				const path = field({ params, key: "path" });
				return { path, ...measurements[String(path)], cached: false };
			}
			if (field({ params, key: "plan" }))
				return { ok: true, revision: 3, audioSources, tightening };
			return { ok: true, revision: 4 };
		});
		const result = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 3, sections, pauses: tightening.pauses },
		});
		expect(result.isError).toBeFalsy();
		const passes = calls.filter(([method]) => method === "editor.roughCut");
		expect(passes).toHaveLength(2);
		expect(passes[0][1]).toMatchObject({
			plan: true,
			pauses: tightening.pauses,
		});
		expect(field({ params: passes[0][1], key: "tightening" })).toBeUndefined();
		expect(passes[1][1]).toMatchObject({ tightening });
		expect(field({ params: passes[1][1], key: "pauses" })).toBeUndefined();
	});

	test("rough_cut skips a recording splice can't measure and still cuts", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "editor.getState")
				return { project: { format: "horizontal" } };
			if (method === "loudness.measure") {
				const path = field({ params, key: "path" });
				if (path === "loud.wav")
					throw new RpcCallError({
						code: -32603,
						message: "ffmpeg exited with 183.",
					});
				return { path, ...measurements[String(path)], cached: false };
			}
			if (field({ params, key: "plan" }))
				return { ok: true, revision: 3, audioSources, tightening };
			return { ok: true, revision: 4 };
		});
		const result = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 3, sections },
		});
		expect(result.isError).toBeFalsy();
		expect(calls.at(-1)?.[1]).toMatchObject({
			sourceGains: [{ projectItemId: "rec-1", gainDb: 14 }],
		});
		expect(JSON.parse(textOf(result)).loudness.sources[1]).toEqual({
			projectItemId: "rec-2",
			path: "loud.wav",
			noiseReduction: false,
			skipped: "Couldn't be measured: ffmpeg exited with 183.",
		});
	});

	test("rough_cut in a Short project captions and normalizes in one cut", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "editor.getState") return { project: { format: "short" } };
			if (method === "editor.listItems")
				return [
					{ id: "rec-1", type: "video", path: "quiet.wav", missing: false },
					{ id: "rec-2", type: "video", path: "loud.wav", missing: false },
				];
			if (method === "transcript.words")
				return {
					transcripts: [
						{ path: "quiet.wav", words: [{ start: 2, end: 2.4, text: "Hi" }] },
					],
					missing: ["loud.wav"],
				};
			if (method === "loudness.measure") {
				const path = field({ params, key: "path" });
				return { path, ...measurements[String(path)], cached: false };
			}
			if (field({ params, key: "plan" }))
				return { ok: true, revision: 3, audioSources, tightening };
			return {
				ok: true,
				revision: 4,
				captionCount: 1,
				uncaptionedItemIds: ["rec-2"],
			};
		});
		const result = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 3, sections },
		});
		expect(result.isError).toBeFalsy();
		const captions = {
			sources: [
				{ projectItemId: "rec-1", words: [{ start: 2, end: 2.4, text: "Hi" }] },
			],
		};
		expect(calls.at(-1)).toEqual([
			"editor.roughCut",
			{
				expectedRevision: 3,
				sections,
				...applyDefaults,
				captions,
				sourceGains: [
					{ projectItemId: "rec-1", gainDb: 14 },
					{ projectItemId: "rec-2", gainDb: 1.45 },
				],
				tightening,
			},
		]);
		expect(
			calls.find(([, params]) => field({ params, key: "plan" }))?.[1],
		).toMatchObject({ captions });
		expect(JSON.parse(textOf(result))).toMatchObject({
			captionCount: 1,
			uncaptionedRecordings: ["loud.wav"],
			loudness: { targetLufs: -14 },
		});
	});

	test("rough_cut measures a recording whose cut keeps more ranges than measure_loudness takes", async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-many-ranges-"));
		await mkdir(join(root, "Footage"));
		await writeFile(join(root, "Footage", "quiet.wav"), "audio");
		const measured: unknown[] = [];
		const meter = createLoudnessMeter({
			root,
			noiseReduction: {
				ensure: () => Promise.reject(new Error("must not reduce noise")),
			},
			measure: async ({ ranges }) => {
				measured.push(ranges);
				return { integratedLufs: -28, truePeakDbtp: -20, lraLu: 4 };
			},
		});
		// Tightening a long talk leaves one range between each two pauses.
		const ranges = Array.from({ length: 5_001 }, (_, index) => ({
			start: index,
			end: index + 0.5,
		}));
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "editor.getState")
				return { project: { format: "horizontal" } };
			// As splice answers the RPC, schema and all.
			if (method === "loudness.measure")
				return meter.measure({ params }).catch((error: unknown) => {
					if (!(error instanceof BridgeError)) throw error;
					throw new RpcCallError({ code: error.code, message: error.message });
				});
			if (field({ params, key: "plan" }))
				return {
					ok: true,
					revision: 3,
					audioSources: [{ ...audioSources[0], ranges }],
					tightening,
				};
			return { ok: true, revision: 4, sequenceId: "cut", sections: [] };
		});
		try {
			const result = await client.callTool({
				name: "rough_cut",
				arguments: { expectedRevision: 3, sections },
			});
			expect(result.isError).toBeFalsy();
			expect(measured).toEqual([ranges]);
			expect(calls.at(-1)).toEqual([
				"editor.roughCut",
				{
					expectedRevision: 3,
					sections,
					...applyDefaults,
					sourceGains: [{ projectItemId: "rec-1", gainDb: 14 }],
					tightening,
				},
			]);
		} finally {
			await meter.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rough_cut with loudness false is one call, and a refused plan measures nothing", async () => {
		const calls: string[] = [];
		const client = await connect(async ({ method }) => {
			calls.push(method);
			if (method === "editor.getState")
				return { project: { format: "horizontal" } };
			return { ok: false, code: "REVISION_CONFLICT", message: "changed" };
		});
		const plain = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 3, sections, loudness: false },
		});
		const normalized = await client.callTool({
			name: "rough_cut",
			arguments: {
				expectedRevision: 3,
				sections,
				loudness: { targetLufs: -16 },
			},
		});
		expect(plain.isError).toBe(true);
		expect(normalized.isError).toBe(true);
		expect(calls).toEqual([
			"editor.getState",
			"editor.roughCut",
			"editor.getState",
			"editor.roughCut",
		]);
	});

	test("normalize_loudness sets one gain per recording on the active sequence in one apply", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "editor.audioSources")
				return { ok: true, sequenceId: "seq-1", revision: 7, audioSources };
			if (method === "loudness.measure") {
				const path = field({ params, key: "path" });
				return { path, ...measurements[String(path)], cached: true };
			}
			return {
				ok: true,
				revision: 8,
				label: "Agent: normalize loudness",
				summary: [],
			};
		});
		const result = await client.callTool({
			name: "normalize_loudness",
			arguments: { expectedRevision: 7, targetLufs: -16 },
		});
		expect(result.isError).toBeFalsy();
		expect(calls.at(-1)).toEqual([
			"editor.apply",
			{
				sequenceId: "seq-1",
				expectedRevision: 7,
				label: "Agent: normalize loudness",
				ops: [
					{ op: "set_gain", clipIds: ["c1", "c2"], gainDb: 12 },
					{ op: "set_gain", clipIds: ["c3"], gainDb: 1.45 },
				],
			},
		]);
	});

	test("normalize_loudness gains a recording's denoised and plain clips apart", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "editor.audioSources")
				return {
					ok: true,
					sequenceId: "seq-1",
					revision: 7,
					audioSources: [
						audioSources[0],
						{ ...audioSources[0], noiseReduction: true, clipIds: ["c9"] },
					],
				};
			if (method === "loudness.measure") {
				const denoised = field({ params, key: "noiseReduction" });
				return {
					integratedLufs: denoised ? -30 : -28,
					truePeakDbtp: -20,
					lraLu: 4,
					cached: true,
				};
			}
			return { ok: true, revision: 8, label: "x", summary: [] };
		});
		const result = await client.callTool({
			name: "normalize_loudness",
			arguments: { expectedRevision: 7 },
		});
		expect(result.isError).toBeFalsy();
		expect(field({ params: calls.at(-1)?.[1], key: "ops" })).toEqual([
			{ op: "set_gain", clipIds: ["c1", "c2"], gainDb: 14 },
			{ op: "set_gain", clipIds: ["c9"], gainDb: 16 },
		]);
	});

	test("measure_loudness forwards the path and ranges to splice", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			return { integratedLufs: -20, truePeakDbtp: -3, lraLu: 2 };
		});
		const args = { path: "Day 1/take.mov", ranges: [{ start: 1, end: 3 }] };
		const result = await client.callTool({
			name: "measure_loudness",
			arguments: args,
		});
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual([["loudness.measure", args]]);
		const refused = await client.callTool({
			name: "measure_loudness",
			arguments: { path: "../outside.wav" },
		});
		expect(refused.isError).toBe(true);
		expect(calls).toHaveLength(1);
	});
});

describe("noise reduction tools", () => {
	// As the tab lists them once noise reduction is set: one source per
	// recording, its ranges in playing order.
	const heard = [
		{
			...audioSources[0],
			clipIds: ["c1", "c4", "c2"],
			ranges: [
				{ start: 2, end: 6 },
				{ start: 8, end: 12 },
				{ start: 6, end: 9 },
			],
		},
		audioSources[1],
		{
			projectItemId: "browser",
			path: null,
			noiseReduction: false,
			missing: false,
			clipIds: ["c5"],
			ranges: [{ start: 0, end: 1 }],
		},
		{
			projectItemId: "gone",
			path: "gone.wav",
			noiseReduction: false,
			missing: true,
			clipIds: ["c6"],
			ranges: [{ start: 0, end: 1 }],
		},
	];
	const denoised: Record<string, object> = {
		"quiet.wav": { integratedLufs: -28.5, truePeakDbtp: -21, lraLu: 4 },
		"loud.wav": { integratedLufs: -18.4, truePeakDbtp: -3, lraLu: 6 },
	};

	function fakeSplice({
		calls,
		denoisedNow = [],
		renderNoiseReduction,
		switchesSequence = false,
	}: {
		calls: Array<[string, unknown]>;
		/** Recordings whose clips have noise reduction on now. */
		denoisedNow?: string[];
		/** Another sequence becomes active between the two source reads. */
		switchesSequence?: boolean;
		/** Answers `noiseReduction.render` in place of a fixed result. */
		renderNoiseReduction?: (params: unknown) => Promise<unknown>;
	}): RpcCall {
		return async ({ method, params }) => {
			calls.push([method, params]);
			const path = String(field({ params, key: "path" }));
			if (method === "editor.getState")
				return { project: { format: "horizontal" } };
			if (method === "editor.audioSources") {
				const requested = field({ params, key: "noiseReduction" });
				return {
					ok: true,
					sequenceId:
						switchesSequence && requested !== undefined ? "seq-2" : "seq-1",
					revision: 7,
					audioSources: heard.map((source) => ({
						...source,
						noiseReduction:
							source.path !== null &&
							(requested === undefined
								? denoisedNow.includes(source.projectItemId)
								: requested === true),
					})),
				};
			}
			if (method === "noiseReduction.render") {
				if (renderNoiseReduction) return renderNoiseReduction(params);
				return {
					path,
					cached: false,
					noiseProfile: { sampledAt: 4, rmsDb: -50 },
				};
			}
			if (method === "loudness.measure")
				return {
					path,
					...(field({ params, key: "noiseReduction" })
						? denoised[path]
						: measurements[path]),
					cached: false,
				};
			if (field({ params, key: "plan" }))
				return {
					ok: true,
					revision: 3,
					audioSources: audioSources.map((source) => ({
						...source,
						noiseReduction: true,
					})),
					tightening,
				};
			return { ok: true, revision: 8, label: "x", summary: [] };
		};
	}

	test("noise_reduction renders each recording, measures the denoised audio and applies flags and gains as one undo step", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(fakeSplice({ calls }));
		const result = await client.callTool({
			name: "noise_reduction",
			arguments: { expectedRevision: 7, enabled: true },
		});
		expect(result.isError).toBeFalsy();
		expect(
			calls.map(([method, params]) => [method, field({ params, key: "path" })]),
		).toEqual([
			["editor.audioSources", undefined],
			["editor.audioSources", undefined],
			["noiseReduction.render", "quiet.wav"],
			["noiseReduction.render", "loud.wav"],
			["loudness.measure", "quiet.wav"],
			["loudness.measure", "loud.wav"],
			["editor.apply", undefined],
		]);
		// The tab is asked for each recording as it will sound denoised, and
		// rec-1's clips are measured together, in playing order.
		expect(calls[0][1]).toBeUndefined();
		expect(calls[1][1]).toEqual({ noiseReduction: true });
		expect(calls[4][1]).toEqual({
			path: "quiet.wav",
			ranges: [
				{ start: 2, end: 6 },
				{ start: 8, end: 12 },
				{ start: 6, end: 9 },
			],
			noiseReduction: true,
		});
		expect(calls.at(-1)).toEqual([
			"editor.apply",
			{
				sequenceId: "seq-1",
				expectedRevision: 7,
				label: "Agent: noise reduction on",
				ops: [
					{
						op: "set_noise_reduction",
						clipIds: ["c1", "c4", "c2", "c3"],
						enabled: true,
					},
					{ op: "set_gain", clipIds: ["c1", "c4", "c2"], gainDb: 14.5 },
					{ op: "set_gain", clipIds: ["c3"], gainDb: 1.95 },
				],
			},
		]);
		const report = JSON.parse(textOf(result));
		expect(report.noiseReduction).toEqual({
			enabled: true,
			recordings: [
				{
					path: "quiet.wav",
					cached: false,
					noiseProfile: { sampledAt: 4, rmsDb: -50 },
				},
				{
					path: "loud.wav",
					cached: false,
					noiseProfile: { sampledAt: 4, rmsDb: -50 },
				},
			],
			skipped: [
				{
					projectItemId: "browser",
					reason:
						"Stored in the browser, not under Footage, so splice can't reduce its noise.",
				},
				{
					projectItemId: "gone",
					reason: expect.stringContaining("Missing from Footage"),
				},
			],
		});
		expect(report.loudness.sources[0]).toMatchObject({
			noiseReduction: true,
			measured: { integratedLufs: -28.5 },
		});
	});

	test("noise_reduction changes nothing when the active sequence changes between its reads", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(fakeSplice({ calls, switchesSequence: true }));
		const result = await client.callTool({
			name: "noise_reduction",
			arguments: { expectedRevision: 7, enabled: true },
		});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain(
			"The active sequence changed while reading it.",
		);
		expect(calls.map(([method]) => method)).toEqual([
			"editor.audioSources",
			"editor.audioSources",
		]);
	});

	test("noise_reduction can target one recording, keep gains, or turn off without rendering", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(fakeSplice({ calls, denoisedNow: ["rec-1"] }));
		await client.callTool({
			name: "noise_reduction",
			arguments: {
				expectedRevision: 7,
				enabled: true,
				projectItemIds: ["rec-2"],
				loudness: false,
			},
		});
		expect(calls.map(([method]) => method)).toEqual([
			"editor.audioSources",
			"editor.audioSources",
			"noiseReduction.render",
			"editor.apply",
		]);
		expect(field({ params: calls.at(-1)?.[1], key: "ops" })).toEqual([
			{ op: "set_noise_reduction", clipIds: ["c3"], enabled: true },
		]);

		calls.length = 0;
		await client.callTool({
			name: "noise_reduction",
			arguments: {
				expectedRevision: 7,
				enabled: false,
				projectItemIds: ["rec-1"],
			},
		});
		expect(calls.map(([method]) => method)).toEqual([
			"editor.audioSources",
			"editor.audioSources",
			"loudness.measure",
			"editor.apply",
		]);
		expect(calls[2][1]).toMatchObject({ noiseReduction: false });
		expect(field({ params: calls.at(-1)?.[1], key: "ops" })).toEqual([
			{
				op: "set_noise_reduction",
				clipIds: ["c1", "c4", "c2"],
				enabled: false,
			},
			{ op: "set_gain", clipIds: ["c1", "c4", "c2"], gainDb: 14 },
		]);
		expect(field({ params: calls.at(-1)?.[1], key: "label" })).toBe(
			"Agent: noise reduction off",
		);
	});

	test("noise_reduction refuses recordings the sequence doesn't play, and browser-only targets", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(fakeSplice({ calls }));
		const unknown = await client.callTool({
			name: "noise_reduction",
			arguments: {
				expectedRevision: 7,
				enabled: true,
				projectItemIds: ["nope"],
			},
		});
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toContain("Not heard in the active sequence: nope");
		const browser = await client.callTool({
			name: "noise_reduction",
			arguments: {
				expectedRevision: 7,
				enabled: true,
				projectItemIds: ["browser"],
			},
		});
		expect(browser.isError).toBe(true);
		expect(JSON.parse(textOf(browser))).toMatchObject({
			message: "Nothing to change.",
			skipped: [{ projectItemId: "browser" }],
		});
		const gone = await client.callTool({
			name: "noise_reduction",
			arguments: {
				expectedRevision: 7,
				enabled: true,
				projectItemIds: ["gone"],
			},
		});
		expect(gone.isError).toBe(true);
		expect(JSON.parse(textOf(gone))).toMatchObject({
			message: "Nothing to change.",
			skipped: [
				{
					projectItemId: "gone",
					reason: expect.stringContaining("Missing from Footage"),
				},
			],
		});
		expect(calls.map(([method]) => method)).toEqual(
			Array(6).fill("editor.audioSources"),
		);
	});

	test("noise_reduction leaves recordings already set that way, their gains included", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(fakeSplice({ calls, denoisedNow: ["rec-1"] }));
		const result = await client.callTool({
			name: "noise_reduction",
			arguments: { expectedRevision: 7, enabled: true },
		});
		expect(result.isError).toBeFalsy();
		expect(
			calls
				.filter(([method]) => method !== "editor.audioSources")
				.map(([method, params]) => [method, field({ params, key: "path" })]),
		).toEqual([
			["noiseReduction.render", "loud.wav"],
			["loudness.measure", "loud.wav"],
			["editor.apply", undefined],
		]);
		expect(field({ params: calls.at(-1)?.[1], key: "ops" })).toEqual([
			{ op: "set_noise_reduction", clipIds: ["c3"], enabled: true },
			{ op: "set_gain", clipIds: ["c3"], gainDb: 1.95 },
		]);
		expect(JSON.parse(textOf(result)).noiseReduction.skipped[0]).toEqual({
			projectItemId: "rec-1",
			reason: "Noise reduction is already on.",
		});

		// Off for a recording that's already plain changes nothing.
		calls.length = 0;
		const off = await client.callTool({
			name: "noise_reduction",
			arguments: {
				expectedRevision: 7,
				enabled: false,
				projectItemIds: ["rec-2"],
			},
		});
		expect(off.isError).toBe(true);
		expect(JSON.parse(textOf(off))).toMatchObject({
			message: "Nothing to change.",
			skipped: [
				{ projectItemId: "rec-2", reason: "Noise reduction is already off." },
			],
		});
		expect(calls.map(([method]) => method)).not.toContain("editor.apply");
	});

	test("noise_reduction skips a recording that leaves Footage while rendering and changes the rest", async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-mcp-"));
		await mkdir(join(root, "Footage"));
		for (const name of ["quiet.wav", "loud.wav"])
			await writeFile(join(root, "Footage", name), "audio");
		// loud.wav leaves Footage once identified, before FFmpeg opens it.
		const reducer = createNoiseReducer({
			root,
			render: async (request) => {
				if (basename(request.source) === "loud.wav") {
					await rm(request.source);
					return renderDenoised(request);
				}
				await writeFile(request.output, "denoised");
				return { noiseWindow: null };
			},
		});
		const calls: Array<[string, unknown]> = [];
		const client = await connect(
			fakeSplice({
				calls,
				// As splice answers the RPC.
				renderNoiseReduction: (params) =>
					reducer.render({ params }).catch((error: unknown) => {
						if (!(error instanceof BridgeError)) throw error;
						throw new RpcCallError({
							code: error.code,
							message: error.message,
							data: error.data,
						});
					}),
			}),
		);
		const result = await client.callTool({
			name: "noise_reduction",
			arguments: { expectedRevision: 7, enabled: true },
		});
		await reducer.stop();
		await rm(root, { recursive: true, force: true });
		expect(result.isError).toBeFalsy();
		expect(
			calls
				.filter(([method]) => method !== "editor.audioSources")
				.map(([method, params]) => [method, field({ params, key: "path" })]),
		).toEqual([
			["noiseReduction.render", "quiet.wav"],
			["noiseReduction.render", "loud.wav"],
			["loudness.measure", "quiet.wav"],
			["editor.apply", undefined],
		]);
		expect(field({ params: calls.at(-1)?.[1], key: "ops" })).toEqual([
			{
				op: "set_noise_reduction",
				clipIds: ["c1", "c4", "c2"],
				enabled: true,
			},
			{ op: "set_gain", clipIds: ["c1", "c4", "c2"], gainDb: 14.5 },
		]);
		const report = JSON.parse(textOf(result)).noiseReduction;
		expect(report.recordings).toHaveLength(1);
		expect(report.skipped).toContainEqual({
			projectItemId: "rec-2",
			reason: expect.stringContaining("Missing from Footage"),
		});

		// Any other render error still fails the tool.
		const failing = await connect(async (call) => {
			if (call.method === "noiseReduction.render")
				throw new RpcCallError({
					code: -32603,
					message: "ffmpeg exited with 1.",
				});
			return fakeSplice({ calls: [] })(call);
		});
		const failed = await failing.callTool({
			name: "noise_reduction",
			arguments: { expectedRevision: 7, enabled: true },
		});
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("ffmpeg exited with 1.");
	});

	test("rough_cut with noiseReduction renders, measures the tightened audio after noise reduction, then cuts", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(fakeSplice({ calls }));
		const result = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 3, sections, noiseReduction: true },
		});
		expect(result.isError).toBeFalsy();
		expect(calls.map(([method]) => method)).toEqual([
			"editor.getState",
			"editor.roughCut",
			"noiseReduction.render",
			"noiseReduction.render",
			"loudness.measure",
			"loudness.measure",
			"editor.roughCut",
		]);
		expect(calls[1][1]).toEqual({
			expectedRevision: 3,
			sections,
			noiseReduction: true,
			...tightenDefaults,
			plan: true,
		});
		// The plan's sources are what tightening keeps, measured denoised.
		expect(calls[4][1]).toEqual({
			path: "quiet.wav",
			ranges: [{ start: 2, end: 9 }],
			noiseReduction: true,
		});
		expect(calls.at(-1)?.[1]).toEqual({
			expectedRevision: 3,
			sections,
			noiseReduction: true,
			...applyDefaults,
			tightening,
			sourceGains: [
				{ projectItemId: "rec-1", noiseReduction: true, gainDb: 14.5 },
				{ projectItemId: "rec-2", noiseReduction: true, gainDb: 1.95 },
			],
		});
		expect(JSON.parse(textOf(result)).noiseReduction.recordings).toHaveLength(
			2,
		);

		// Without loudness, it still plans so the renders are ready.
		calls.length = 0;
		await client.callTool({
			name: "rough_cut",
			arguments: {
				expectedRevision: 3,
				sections,
				noiseReduction: true,
				loudness: false,
			},
		});
		expect(calls.map(([method]) => method)).toEqual([
			"editor.getState",
			"editor.roughCut",
			"noiseReduction.render",
			"noiseReduction.render",
			"editor.roughCut",
		]);
		expect(calls.at(-1)?.[1]).toEqual({
			expectedRevision: 3,
			sections,
			noiseReduction: true,
			...applyDefaults,
			tightening,
		});
	});
});

describe("final mix tools", () => {
	test("music_add forwards the Footage path and revision in one editor operation", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			return { ok: true, revision: 4 };
		});
		const result = await client.callTool({
			name: "music_add",
			arguments: { path: "music/song.mp3", expectedRevision: 3, duckDb: -18 },
		});
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual([
			[
				"editor.addMusic",
				{ expectedRevision: 3, duckDb: -18, path: "music/song.mp3" },
			],
		]);
	});

	test("music_add takes a path or a project item, not both", async () => {
		const client = await connect(async () => ({ ok: true }));
		const result = await client.callTool({
			name: "music_add",
			arguments: { path: "song.mp3", projectItemId: "song", expectedRevision: 1 },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("either path or projectItemId");
	});

	test("mix_loudness and mix_status reach the editor", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			return { ok: true };
		});
		await client.callTool({
			name: "mix_loudness",
			arguments: { expectedRevision: 2 },
		});
		await client.callTool({ name: "mix_status", arguments: {} });
		expect(calls).toEqual([
			["editor.mixLoudness", { expectedRevision: 2, apply: true }],
			["editor.mixStatus", {}],
		]);
	});
});
