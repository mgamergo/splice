import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp";
import { RpcCallError, type RpcCall } from "../rpc-client";

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

describe("splice mcp tools", () => {
	test("lists the tools", async () => {
		const client = await connect(async () => null);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"captions_add",
			"detect_pauses",
			"editor_status",
			"footage_list",
			"items_import",
			"items_list",
			"measure_loudness",
			"normalize_loudness",
			"raw_sequence",
			"rough_cut",
			"sequence_apply",
			"sequence_get",
			"takes_list",
			"transcribe",
			"transcribe_status",
		]);
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
			"transcribe each recording (includeWords for word timings) → detect_pauses → plan the sections, takes and false starts",
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
		missing: false,
		clipIds: ["c1", "c2"],
		ranges: [{ start: 2, end: 9 }],
	},
	{
		projectItemId: "rec-2",
		path: "loud.wav",
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
				{ path: "quiet.wav", ranges: [{ start: 2, end: 9 }] },
			],
			[
				"loudness.measure",
				{ path: "loud.wav", ranges: [{ start: 0, end: 5 }] },
			],
			[
				"editor.roughCut",
				{
					expectedRevision: 3,
					sections,
					...tightenDefaults,
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
				...tightenDefaults,
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
