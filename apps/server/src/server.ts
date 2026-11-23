import {
	BRIDGE_PATHS,
	isRpcRequest,
	isServerMethod,
	isTabMethod,
	parseRpcMessage,
	RPC_ERRORS,
	SERVER_NAME,
	TAB_CLOSE_CODES,
	TAB_HELLO,
	type RpcId,
	type RpcResponse,
	type ServerStatus,
} from "@splice/bridge";
import type { Server, ServerWebSocket } from "bun";
import { tokensMatch } from "./session";
import { BridgeError, TabBridge } from "./tab-bridge";

const TAB_AUTH_TIMEOUT_MS = 5_000;
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;

type SocketData =
	| { kind: "tab"; authed: boolean; authTimer: ReturnType<typeof setTimeout> | null }
	| { kind: "proxy"; path: string; upstream: WebSocket | null; queue: Array<string | Buffer> };

export interface StartServerOptions {
	/** 0 picks a free port (tests). */
	port: number;
	token: string;
	root: string;
	/** Origin of the editor's Next.js server, or null to serve only `/splice/*`. */
	upstream: string | null;
	/** While false, editor pages answer 503 "starting". */
	isUpstreamReady?: () => boolean;
}

export interface RunningServer {
	server: Server<SocketData>;
	bridge: TabBridge;
	/** `http://127.0.0.1:<port>` */
	origin: string;
	stop(): void;
}

function rpcResult({ id, result }: { id: RpcId | null; result: unknown }): RpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function rpcError({ id, code, message, data }: { id: RpcId | null; code: number; message: string; data?: unknown }): RpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/**
 * The browser only ever reaches `splice` through loopback names. Checking Host
 * stops DNS-rebinding pages from talking to it under their own origin.
 */
export function isAllowedHost({ host, port }: { host: string | null; port: number }): boolean {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function isAllowedOrigin({ origin, port }: { origin: string | null; port: number }): boolean {
	return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function startServer({ port, token, root, upstream, isUpstreamReady = () => true }: StartServerOptions): RunningServer {
	const bridge = new TabBridge();

	async function handleRpc(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		// Browsers always send Origin on a POST. Only `splice mcp` may use this endpoint.
		if (request.headers.get("origin") !== null) {
			return new Response("Forbidden", { status: 403 });
		}
		const auth = request.headers.get("authorization");
		const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
		if (!tokensMatch({ expected: token, actual: bearer })) {
			return new Response("Unauthorized", { status: 401 });
		}
		const text = await request.text();
		if (text.length > MAX_RPC_BODY_BYTES) {
			return Response.json(rpcError({ id: null, code: RPC_ERRORS.INVALID_REQUEST, message: "Request too large" }));
		}
		const message = parseRpcMessage(text);
		if (!message || !isRpcRequest(message)) {
			return Response.json(rpcError({ id: null, code: RPC_ERRORS.INVALID_REQUEST, message: "Expected a JSON-RPC request" }));
		}
		const { id, method, params } = message;
		if (isServerMethod(method)) {
			const status: ServerStatus = { tabConnected: bridge.isConnected(), revision: bridge.getRevision(), root };
			return Response.json(rpcResult({ id, result: status }));
		}
		if (!isTabMethod(method)) {
			return Response.json(rpcError({ id, code: RPC_ERRORS.METHOD_NOT_FOUND, message: `Unknown method ${method}` }));
		}
		try {
			const result = await bridge.call({ method, params });
			return Response.json(rpcResult({ id, result }));
		} catch (error) {
			if (error instanceof BridgeError) {
				return Response.json(rpcError({ id, code: error.code, message: error.message, data: error.data }));
			}
			throw error;
		}
	}

	async function proxy(request: Request, url: URL): Promise<Response> {
		if (!upstream) {
			return new Response("Not found", { status: 404 });
		}
		if (!isUpstreamReady()) {
			return new Response("Splice is starting the editor. Reload in a few seconds.", {
				status: 503,
				headers: { "retry-after": "2", "content-type": "text/plain; charset=utf-8" },
			});
		}
		const headers = new Headers(request.headers);
		// Loopback needs no compression, and fetch would decode it without fixing the headers.
		headers.delete("accept-encoding");
		const hasBody = request.method !== "GET" && request.method !== "HEAD";
		const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
			method: request.method,
			headers,
			body: hasBody ? await request.arrayBuffer() : undefined,
			redirect: "manual",
		});
		const responseHeaders = new Headers(response.headers);
		responseHeaders.delete("content-encoding");
		responseHeaders.delete("content-length");
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
	}

	function sendTo(ws: ServerWebSocket<SocketData>, response: RpcResponse) {
		ws.send(JSON.stringify(response));
	}

	function handleTabMessage(ws: ServerWebSocket<SocketData>, text: string) {
		const data = ws.data;
		if (data.kind !== "tab") {
			return;
		}
		if (data.authed) {
			bridge.handleMessage({ socket: ws, text });
			return;
		}
		const message = parseRpcMessage(text);
		const params = message && isRpcRequest(message) && message.method === TAB_HELLO ? message.params : null;
		const offered =
			typeof params === "object" && params !== null && "token" in params && typeof params.token === "string"
				? params.token
				: null;
		if (!message || !isRpcRequest(message) || !tokensMatch({ expected: token, actual: offered })) {
			ws.close(TAB_CLOSE_CODES.UNAUTHORIZED, "Unauthorized");
			return;
		}
		data.authed = true;
		if (data.authTimer) {
			clearTimeout(data.authTimer);
			data.authTimer = null;
		}
		bridge.attach(ws);
		sendTo(ws, rpcResult({ id: message.id, result: { server: SERVER_NAME } }));
	}

	function openProxySocket(ws: ServerWebSocket<SocketData>) {
		const data = ws.data;
		if (data.kind !== "proxy" || !upstream) {
			return;
		}
		const upstreamSocket = new WebSocket(`${upstream.replace(/^http/, "ws")}${data.path}`);
		data.upstream = upstreamSocket;
		upstreamSocket.addEventListener("open", () => {
			for (const queued of data.queue) {
				upstreamSocket.send(queued);
			}
			data.queue = [];
		});
		upstreamSocket.addEventListener("message", (event) => {
			const payload: unknown = event.data;
			if (typeof payload === "string" || payload instanceof ArrayBuffer) {
				ws.send(payload);
			}
		});
		upstreamSocket.addEventListener("close", () => ws.close());
		upstreamSocket.addEventListener("error", () => ws.close());
	}

	const server = Bun.serve<SocketData>({
		hostname: "127.0.0.1",
		port,
		idleTimeout: 120,
		async fetch(request, srv) {
			const url = new URL(request.url);
			const actualPort = srv.port ?? port;
			if (!isAllowedHost({ host: request.headers.get("host"), port: actualPort })) {
				return new Response("Forbidden host", { status: 403 });
			}
			if (url.pathname === BRIDGE_PATHS.health) {
				return Response.json({ name: SERVER_NAME, ok: true });
			}
			const isUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
			if (url.pathname === BRIDGE_PATHS.tab) {
				if (!isUpgrade || !isAllowedOrigin({ origin: request.headers.get("origin"), port: actualPort })) {
					return new Response("Forbidden", { status: 403 });
				}
				const upgraded = srv.upgrade(request, { data: { kind: "tab", authed: false, authTimer: null } });
				return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
			}
			if (url.pathname === BRIDGE_PATHS.rpc) {
				return handleRpc(request);
			}
			if (url.pathname.startsWith("/splice/")) {
				return new Response("Not found", { status: 404 });
			}
			if (isUpgrade) {
				if (!upstream || !isAllowedOrigin({ origin: request.headers.get("origin"), port: actualPort })) {
					return new Response("Forbidden", { status: 403 });
				}
				const upgraded = srv.upgrade(request, {
					data: { kind: "proxy", path: `${url.pathname}${url.search}`, upstream: null, queue: [] },
				});
				return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
			}
			return proxy(request, url);
		},
		websocket: {
			open(ws) {
				if (ws.data.kind === "tab") {
					ws.data.authTimer = setTimeout(() => ws.close(TAB_CLOSE_CODES.UNAUTHORIZED, "No hello"), TAB_AUTH_TIMEOUT_MS);
				} else {
					openProxySocket(ws);
				}
			},
			message(ws, message) {
				if (ws.data.kind === "tab") {
					handleTabMessage(ws, typeof message === "string" ? message : message.toString("utf8"));
					return;
				}
				const upstreamSocket = ws.data.upstream;
				if (upstreamSocket?.readyState === WebSocket.OPEN) {
					upstreamSocket.send(message);
				} else {
					ws.data.queue.push(message);
				}
			},
			close(ws) {
				if (ws.data.kind === "tab") {
					if (ws.data.authTimer) {
						clearTimeout(ws.data.authTimer);
					}
					bridge.detach(ws);
				} else {
					ws.data.upstream?.close();
				}
			},
		},
	});

	return {
		server,
		bridge,
		origin: `http://127.0.0.1:${server.port}`,
		stop() {
			// Not awaited: in Bun 1.2 the promise never settles once a WebSocket has connected.
			void server.stop(true);
		},
	};
}
