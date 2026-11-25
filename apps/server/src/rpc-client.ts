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

const MINUTE_MS = 60_000;

/**
 * Methods whose work grows with the footage: imports probe every file,
 * rough cuts, pause scans, loudness measures and noise-reduction renders run
 * FFmpeg over whole recordings, and the editor decodes and measures the whole
 * mix or music track. Hours of footage take minutes, so they get half an hour.
 */
const LONG_METHODS: ReadonlySet<string> = new Set([
	"editor.importItems",
	"editor.roughCut",
	"pauses.detect",
	"loudness.measure",
	"noiseReduction.render",
	"editor.addMusic",
	"editor.updateMusic",
	"editor.mixLoudness",
	"storage.report",
	"storage.cleanup",
]);

/** Whether `splice mcp` gives a call the long deadline. */
export function isLongMethod(method: string): boolean {
	return LONG_METHODS.has(method);
}

/**
 * How long `splice mcp` waits for `splice` to answer a call. Everything else
 * answers within the tab bridge's 30 s deadline, or transcribe's 30 s wait,
 * so two minutes only trips when `splice` has stalled.
 */
export function rpcDeadlineMs(method: string): number {
	return isLongMethod(method) ? 30 * MINUTE_MS : 2 * MINUTE_MS;
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
		const deadlineMs = rpcDeadlineMs(method);
		const signal = AbortSignal.timeout(deadlineMs);
		let status: number;
		let body: string;
		try {
			const response = await fetch(`${origin}${BRIDGE_PATHS.rpc}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
				// Bun drops a response that sends nothing for 5 minutes, and an
				// uncached pause scan or an import sends nothing until it finishes.
				// The method's deadline bounds the wait instead, and hanging up
				// stops the FFmpeg work `splice` was doing for this call.
				timeout: false,
				signal,
			});
			status = response.status;
			body = await response.text();
		} catch (error) {
			if (signal.aborted)
				throw new Error(
					`splice didn't answer ${method} within ${deadlineMs / MINUTE_MS} minutes.`,
				);
			throw error;
		}
		if (status < 200 || status > 299) {
			throw new Error(`splice answered ${status} ${body}`);
		}
		const message = parseRpcMessage(body);
		if (!message || "method" in message) {
			throw new Error("splice sent a malformed response");
		}
		if ("error" in message) {
			throw new RpcCallError(message.error);
		}
		return message.result;
	};
}
