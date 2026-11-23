import {
	isRpcRequest,
	isTabMethod,
	parseRpcMessage,
	RPC_ERRORS,
	STATE_CHANGED,
	TAB_CLOSE_CODES,
	TAB_HELLO,
	type RpcResponse,
	type TabMethod,
} from "@splice/bridge";
import {
	AgentBlockedError,
	InvalidParamsError,
	type TabHandlers,
} from "./handlers";

export type BridgeStatus =
	/** Waiting for `splice`, or reconnecting after it went away. */
	| "connecting"
	| "connected"
	/** `splice` refused the token; the creator must open its link again. */
	| "unauthorized"
	/** Another tab took over the agent connection. */
	| "superseded";

/** The parts of the browser WebSocket the client uses, so tests can fake it. */
export interface BridgeSocket {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: "open", listener: () => void): void;
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: "close",
		listener: (event: { code: number }) => void,
	): void;
}

const HELLO_ID = "hello";
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000];
const OPEN = 1;

export interface AgentBridgeClientOptions {
	url: string;
	token: string;
	handlers: TabHandlers;
	onStatus: (status: BridgeStatus) => void;
	/** Called before the tab handles each agent request. */
	onRequest?: (method: TabMethod) => void;
	createSocket?: (url: string) => BridgeSocket;
}

/**
 * The editor tab's end of the bridge. It connects out to `splice`, answers its
 * requests through `handlers`, reports revision changes, and reconnects when
 * `splice` restarts.
 */
export class AgentBridgeClient {
	private socket: BridgeSocket | null = null;
	private stopped = true;
	private attempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private revision: number | null = null;
	private authed = false;

	constructor(private readonly options: AgentBridgeClientOptions) {}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.socket?.close();
		this.socket = null;
	}

	notifyRevision(revision: number): void {
		this.revision = revision;
		this.sendRevision();
	}

	private sendRevision() {
		if (
			!this.authed ||
			this.revision === null ||
			this.socket?.readyState !== OPEN
		)
			return;
		this.socket.send(
			JSON.stringify({
				jsonrpc: "2.0",
				method: STATE_CHANGED,
				params: { revision: this.revision },
			}),
		);
	}

	private connect() {
		this.options.onStatus("connecting");
		this.authed = false;
		const createSocket =
			this.options.createSocket ??
			((url: string): BridgeSocket => new WebSocket(url));
		const socket = createSocket(this.options.url);
		this.socket = socket;
		socket.addEventListener("open", () => {
			socket.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: HELLO_ID,
					method: TAB_HELLO,
					params: { token: this.options.token },
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				this.handleMessage({ socket, text: event.data });
			}
		});
		socket.addEventListener("close", (event) => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.authed = false;
			if (this.stopped) return;
			if (event.code === TAB_CLOSE_CODES.UNAUTHORIZED) {
				this.options.onStatus("unauthorized");
				return;
			}
			if (event.code === TAB_CLOSE_CODES.SUPERSEDED) {
				this.options.onStatus("superseded");
				return;
			}
			this.scheduleReconnect();
		});
	}

	private scheduleReconnect() {
		this.options.onStatus("connecting");
		const delay =
			RECONNECT_DELAYS_MS[
				Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)
			];
		this.attempts++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.stopped) this.connect();
		}, delay);
	}

	private handleMessage({
		socket,
		text,
	}: {
		socket: BridgeSocket;
		text: string;
	}) {
		const message = parseRpcMessage(text);
		if (!message) return;
		if (!isRpcRequest(message)) {
			if ("id" in message && message.id === HELLO_ID && "result" in message) {
				this.authed = true;
				this.attempts = 0;
				this.options.onStatus("connected");
				this.sendRevision();
			}
			return;
		}
		void this.answer({
			id: message.id,
			method: message.method,
			params: message.params,
		}).then((response) => {
			if (socket.readyState === OPEN) socket.send(JSON.stringify(response));
		});
	}

	private async answer({
		id,
		method,
		params,
	}: {
		id: number | string;
		method: string;
		params: unknown;
	}): Promise<RpcResponse> {
		if (!isTabMethod(method)) {
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: RPC_ERRORS.METHOD_NOT_FOUND,
					message: `Unknown method ${method}`,
				},
			};
		}
		this.options.onRequest?.(method);
		try {
			return {
				jsonrpc: "2.0",
				id,
				result: (await this.options.handlers[method](params)) ?? null,
			};
		} catch (error) {
			if (error instanceof InvalidParamsError) {
				return {
					jsonrpc: "2.0",
					id,
					error: { code: RPC_ERRORS.INVALID_PARAMS, message: error.message },
				};
			}
			if (error instanceof AgentBlockedError) {
				return {
					jsonrpc: "2.0",
					id,
					error: { code: RPC_ERRORS.AGENT_BLOCKED, message: error.message },
				};
			}
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: RPC_ERRORS.INTERNAL,
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}
}
