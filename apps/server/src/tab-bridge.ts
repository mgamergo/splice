import {
	EDITOR_ACTIVITY,
	isRpcNotification,
	isRpcResponse,
	parseRpcMessage,
	RPC_ERRORS,
	STATE_CHANGED,
	type RpcRequest,
	type TabMethod,
} from "@splice/bridge";

/** The part of a WebSocket the bridge needs; Bun's ServerWebSocket satisfies it. */
export interface TabSocket {
	send(data: string): unknown;
}

export class BridgeError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor({
		code,
		message,
		data,
	}: {
		code: number;
		message: string;
		data?: unknown;
	}) {
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
 * Tracks activity from every authenticated tab and routes agent calls to the
 * newest connected tab.
 */
export class TabBridge {
	private tab: TabSocket | null = null;
	private readonly pending = new Map<number, PendingCall>();
	private nextId = 1;
	private readonly revisions = new Map<TabSocket, number | null>();

	constructor(private readonly onActivity?: () => void) {}

	isConnected(): boolean {
		return this.tab !== null;
	}

	/** The last revision the tab reported, or null before it reported one. */
	getRevision(): number | null {
		return this.tab ? (this.revisions.get(this.tab) ?? null) : null;
	}

	/** The attached tab, so a later call can check the same tab still answers. */
	currentTab(): TabSocket | null {
		return this.tab;
	}

	attach(socket: TabSocket): void {
		this.rejectPending();
		this.revisions.set(socket, null);
		this.tab = socket;
		this.onActivity?.();
	}

	detach(socket: TabSocket): void {
		if (!this.revisions.delete(socket)) return;
		this.onActivity?.();
		if (this.tab !== socket) return;
		this.tab = [...this.revisions.keys()].at(-1) ?? null;
		this.rejectPending();
	}

	private rejectPending(): void {
		for (const [id, call] of this.pending) {
			clearTimeout(call.timer);
			call.reject(
				new BridgeError({
					code: RPC_ERRORS.TAB_DISCONNECTED,
					message: "The editor command target changed before answering",
				}),
			);
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
					message:
						"No editor tab is connected. Ask the creator to open the editor link in Chrome; `bun run splice link` prints it.",
				}),
			);
		}
		const id = this.nextId++;
		const request: RpcRequest = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new BridgeError({
						code: RPC_ERRORS.TAB_TIMEOUT,
						message: `The editor tab didn't answer ${method} within ${timeoutMs} ms`,
					}),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			tab.send(JSON.stringify(request));
		});
	}

	/** Accepts activity from any attached tab and replies from the command target. */
	handleMessage({ socket, text }: { socket: TabSocket; text: string }): void {
		if (!this.revisions.has(socket)) {
			return;
		}
		const message = parseRpcMessage(text);
		if (!message) {
			return;
		}
		if (isRpcNotification(message)) {
			if (message.method === EDITOR_ACTIVITY) this.onActivity?.();
			if (message.method === STATE_CHANGED) {
				const params = message.params;
				if (
					typeof params === "object" &&
					params !== null &&
					"revision" in params &&
					typeof params.revision === "number"
				) {
					if (this.revisions.get(socket) !== params.revision)
						this.onActivity?.();
					this.revisions.set(socket, params.revision);
				}
			}
			return;
		}
		if (
			socket !== this.tab ||
			!isRpcResponse(message) ||
			typeof message.id !== "number"
		) {
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
