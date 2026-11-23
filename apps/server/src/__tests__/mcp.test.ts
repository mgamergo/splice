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
