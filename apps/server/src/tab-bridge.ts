import {
	isRpcNotification,
	isRpcResponse,
	parseRpcMessage,
	RPC_ERRORS,
	STATE_CHANGED,
	TAB_CLOSE_CODES,
	type RpcRequest,
	type TabMethod,
} from "@splice/bridge";

/** The part of a WebSocket the bridge needs; Bun's ServerWebSocket satisfies it. */
export interface TabSocket {
	send(data: string): unknown;
	close(code?: number, reason?: string): void;
}

export class BridgeError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor({ code, message, data }: { code: number; message: string; data?: unknown }) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

interface PendingCall {
	resolve: (result: unknown) => void;
	reject: (error: BridgeError) => void;
	timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * Holds the one editor tab the agent talks to and matches its replies to calls.
 * A newly connected tab takes over from the previous one.
 */
export class TabBridge {
	private tab: TabSocket | null = null;
	private readonly pending = new Map<number, PendingCall>();
	private nextId = 1;
	private revision: number | null = null;

	isConnected(): boolean {
		return this.tab !== null;
	}

	/** The last revision the tab reported, or null before it reported one. */
	getRevision(): number | null {
		return this.revision;
	}

	attach(socket: TabSocket): void {
		if (this.tab && this.tab !== socket) {
			const previous = this.tab;
			this.detach(previous);
			previous.close(TAB_CLOSE_CODES.SUPERSEDED, "A newer editor tab connected");
		}
		this.tab = socket;
	}

	detach(socket: TabSocket): void {
		if (this.tab !== socket) {
			return;
		}
		this.tab = null;
		this.revision = null;
		for (const [id, call] of this.pending) {
			clearTimeout(call.timer);
			call.reject(new BridgeError({ code: RPC_ERRORS.TAB_DISCONNECTED, message: "The editor tab disconnected before answering" }));
			this.pending.delete(id);
		}
	}

	call({
		method,
		params,
		timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
	}: {
		method: TabMethod;
		params?: unknown;
		timeoutMs?: number;
	}): Promise<unknown> {
		const tab = this.tab;
		if (!tab) {
			return Promise.reject(
				new BridgeError({
					code: RPC_ERRORS.TAB_NOT_CONNECTED,
					message: "No editor tab is connected. Open the Splice link that `splice` printed when it started.",
				}),
			);
		}
		const id = this.nextId++;
		const request: RpcRequest = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new BridgeError({ code: RPC_ERRORS.TAB_TIMEOUT, message: `The editor tab didn't answer ${method} within ${timeoutMs} ms` }));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			tab.send(JSON.stringify(request));
		});
	}

	/** Handles a message from the attached tab. */
	handleMessage({ socket, text }: { socket: TabSocket; text: string }): void {
		if (socket !== this.tab) {
			return;
		}
		const message = parseRpcMessage(text);
		if (!message) {
			return;
		}
		if (isRpcNotification(message)) {
			if (message.method === STATE_CHANGED) {
				const params = message.params;
				if (typeof params === "object" && params !== null && "revision" in params && typeof params.revision === "number") {
					this.revision = params.revision;
				}
			}
			return;
		}
		if (!isRpcResponse(message) || typeof message.id !== "number") {
			return;
		}
		const call = this.pending.get(message.id);
		if (!call) {
			return;
		}
		this.pending.delete(message.id);
		clearTimeout(call.timer);
		if ("error" in message) {
			call.reject(new BridgeError(message.error));
		} else {
			call.resolve(message.result);
		}
	}
}
