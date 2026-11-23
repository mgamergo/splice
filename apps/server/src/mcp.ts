import { editOpSchema } from "@splice/bridge/ops";
import { BRIDGE_PATHS, SERVER_NAME } from "@splice/bridge";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SpliceConfig } from "./config";
import { createRpcClient, RpcCallError, type RpcCall } from "./rpc-client";
import { readSession } from "./session";

const START_TIMEOUT_MS = 150_000;

function text(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
	const message =
		error instanceof RpcCallError
			? `${error.message} (code ${error.code})`
			: error instanceof Error
				? error.message
				: String(error);
	return { isError: true, content: [{ type: "text", text: message }] };
}

async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await run();
	} catch (error) {
		return failure(error);
	}
}

/** The MCP tools, over any way of reaching `splice`. Kept separate from stdio for tests. */
export function createMcpServer({ rpc }: { rpc: RpcCall }): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: "0.1.0" });

	server.registerTool(
		"editor_status",
		{
			title: "Editor status",
			description: "Whether an editor tab is connected to Splice, its last known revision, and the data folder.",
			inputSchema: {},
		},
		() => guard(async () => text(await rpc("server.status"))),
	);

	server.registerTool(
		"sequence_get",
		{
			title: "Read the active sequence",
			description:
				"Returns the open project's active sequence as a compact digest: tracks (V1 is the main track), clips with ids, in/out points and positions, and markers. The digest names the current revision; pass it to sequence_apply as expectedRevision.",
			inputSchema: {},
		},
		() =>
			guard(async () => {
				const state = await rpc("editor.getState");
				return text(state);
			}),
	);

	server.registerTool(
		"sequence_apply",
		{
			title: "Edit the active sequence",
			description:
				"Applies a batch of edit ops to the active sequence as one undo step. It is refused with REVISION_CONFLICT if the creator changed the sequence since expectedRevision; re-read with sequence_get and plan again. Times are {seconds}, {frame} or {timecode: \"HH:MM:SS:FF\"} on the sequence timeline. If any op fails, nothing is applied.",
			inputSchema: {
				expectedRevision: z.number().int().nonnegative().describe("The revision from the last sequence_get"),
				label: z.string().min(1).max(120).describe("Short undo label shown to the creator, e.g. \"Remove bad takes\""),
				ops: z.array(editOpSchema).min(1),
			},
		},
		(args) =>
			guard(async () => {
				const result = await rpc("editor.apply", args);
				const ok = typeof result === "object" && result !== null && "ok" in result && result.ok === true;
				return ok ? text(result) : { ...text(result), isError: true };
			}),
	);

	return server;
}

async function isSpliceRunning({ origin }: { origin: string }): Promise<boolean> {
	try {
		const response = await fetch(`${origin}${BRIDGE_PATHS.health}`);
		if (!response.ok) {
			return false;
		}
		const body: unknown = await response.json();
		return typeof body === "object" && body !== null && "name" in body && body.name === SERVER_NAME;
	} catch {
		return false;
	}
}

/** Finds the running `splice`, starting it in the background if it isn't up. */
export async function connectToSplice({ config }: { config: SpliceConfig }): Promise<RpcCall> {
	const origin = `http://127.0.0.1:${config.port}`;
	if (!(await isSpliceRunning({ origin }))) {
		const child = Bun.spawn(["bun", `${import.meta.dir}/cli.ts`, "serve"], {
			stdin: "ignore",
			// stdout belongs to the MCP protocol.
			stdout: "ignore",
			stderr: "ignore",
			env: process.env,
		});
		child.unref();
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (!(await isSpliceRunning({ origin }))) {
			if (Date.now() > deadline) {
				throw new Error(`splice didn't start on port ${config.port}. Start it by hand with \`bun run splice\`.`);
			}
			await Bun.sleep(500);
		}
	}
	const deadline = Date.now() + 10_000;
	let session = await readSession({ root: config.root });
	while (!session || session.port !== config.port) {
		if (Date.now() > deadline) {
			throw new Error(`splice is running but ${config.root} has no session for port ${config.port}. Is SPLICE_ROOT the same for both?`);
		}
		await Bun.sleep(250);
		session = await readSession({ root: config.root });
	}
	return createRpcClient({ origin, token: session.token });
}

export async function runMcp({ config }: { config: SpliceConfig }): Promise<void> {
	let rpcPromise: Promise<RpcCall> | null = null;
	// Connect lazily, so the MCP handshake never waits on starting the editor.
	const rpc: RpcCall = async (method, params) => {
		rpcPromise ??= connectToSplice({ config }).catch((error: unknown) => {
			rpcPromise = null;
			throw error;
		});
		return (await rpcPromise)(method, params);
	};
	const server = createMcpServer({ rpc });
	await server.connect(new StdioServerTransport());
}
