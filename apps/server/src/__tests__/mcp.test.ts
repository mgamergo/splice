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

describe("splice mcp tools", () => {
	test("lists the tools", async () => {
		const client = await connect(async () => null);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
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
		clipIds: ["c1", "c2"],
		ranges: [{ start: 2, end: 9 }],
	},
	{
		projectItemId: "rec-2",
		path: "loud.wav",
		clipIds: ["c3"],
		ranges: [{ start: 0, end: 5 }],
	},
];
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
	test("rough_cut with loudness plans, measures what the cut keeps, then cuts with the gains", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(async ({ method, params }) => {
			calls.push([method, params]);
			if (method === "loudness.measure") {
				const path = field({ params, key: "path" });
				return { path, ...measurements[String(path)], cached: false };
			}
			if (field({ params, key: "plan" }))
				return { ok: true, revision: 3, audioSources };
			return { ok: true, revision: 4, sequenceId: "cut", sections: [] };
		});
		const result = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 3, sections, loudness: {} },
		});
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual([
			["editor.roughCut", { expectedRevision: 3, sections, plan: true }],
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
					sourceGains: [
						{ projectItemId: "rec-1", gainDb: 14 },
						{ projectItemId: "rec-2", gainDb: 1.5 },
					],
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

	test("rough_cut without loudness is one call, and a refused plan measures nothing", async () => {
		const calls: string[] = [];
		const client = await connect(async ({ method }) => {
			calls.push(method);
			return { ok: false, code: "REVISION_CONFLICT", message: "changed" };
		});
		const plain = await client.callTool({
			name: "rough_cut",
			arguments: { expectedRevision: 3, sections },
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
		expect(calls).toEqual(["editor.roughCut", "editor.roughCut"]);
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
					{ op: "set_gain", clipIds: ["c3"], gainDb: 1.5 },
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
