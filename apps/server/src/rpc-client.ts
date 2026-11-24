import { BRIDGE_PATHS, parseRpcMessage, type RpcError } from "@splice/bridge";

export class RpcCallError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(error: RpcError) {
		super(error.message);
		this.code = error.code;
		this.data = error.data;
	}
}

export type RpcCall = (call: {
	method: string;
	params?: unknown;
}) => Promise<unknown>;

/** Calls `splice` over its loopback JSON-RPC endpoint. */
export function createRpcClient({
	origin,
	token,
}: {
	origin: string;
	token: string;
}): RpcCall {
	let nextId = 1;
	return async ({ method, params }) => {
		const response = await fetch(`${origin}${BRIDGE_PATHS.rpc}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
			// Bun drops a response that sends nothing for 5 minutes, and an
			// uncached pause scan or an import sends nothing until it finishes.
			// `splice` bounds its own work: bridge calls have deadlines, and
			// FFmpeg scans end with their file.
			timeout: false,
		});
		if (!response.ok) {
			throw new Error(
				`splice answered ${response.status} ${await response.text()}`,
			);
		}
		const message = parseRpcMessage(await response.text());
		if (!message || "method" in message) {
			throw new Error("splice sent a malformed response");
		}
		if ("error" in message) {
			throw new RpcCallError(message.error);
		}
		return message.result;
	};
}
