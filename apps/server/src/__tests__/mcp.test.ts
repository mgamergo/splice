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
			"captions_add",
			"editor_status",
			"footage_list",
			"items_import",
			"items_list",
			"raw_sequence",
			"rough_cut",
			"sequence_apply",
			"sequence_get",
			"takes_list",
			"transcribe",
			"transcribe_status",
		]);
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
			return { ok: true, revision: 4 };
		};
	}

	test("rough_cut adds cached transcript words as captions in a Short project", async () => {
		const calls: Array<[string, unknown]> = [];
		const client = await connect(captionRpc({ format: "short", calls }));
		const result = await client.callTool({
			name: "rough_cut",
			arguments: { ...roughCutArgs, captionStyle: { uppercase: true } },
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result))).toMatchObject({
			uncaptionedRecordings: ["other.mp4"],
			warning: expect.stringContaining("captions_add"),
		});
		expect(
			calls.find(([method]) => method === "transcript.words")?.[1],
		).toEqual({ paths: ["rec.mp4", "other.mp4"] });
		expect(calls.at(-1)).toEqual([
			"editor.roughCut",
			{
				...roughCutArgs,
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
		await client.callTool({ name: "rough_cut", arguments: roughCutArgs });
		expect(calls.map(([method]) => method)).toEqual([
			"editor.getState",
			"editor.roughCut",
		]);
		expect(calls.at(-1)?.[1]).toEqual({ ...roughCutArgs, captions: undefined });
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
