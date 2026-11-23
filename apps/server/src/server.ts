import {
	BRIDGE_PATHS,
	isRpcRequest,
	isServerMethod,
	isTabMethod,
	parseRpcMessage,
	RPC_ERRORS,
	SERVER_NAME,
	sessionCookieName,
	TAB_CLOSE_CODES,
	TAB_HELLO,
	type RpcId,
	type RpcResponse,
	type ServerStatus,
} from "@splice/bridge";
import { roughCutSourcesSchema } from "@splice/bridge/ops";
import type { Server, ServerWebSocket } from "bun";
import {
	FOOTAGE_FOLDER,
	listFootage,
	mediaTypeForPath,
	resolveFootagePath,
	serveFile,
} from "./footage";
import { createPauseDetector } from "./pauses";
import { resolveRoughCutRequest } from "./rough-cut";
import { createToken, tokensMatch } from "./session";
import { BridgeError, TabBridge } from "./tab-bridge";
import { createTranscriptionJobs } from "./transcription";

const TAB_AUTH_TIMEOUT_MS = 5_000;
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;

type SocketData =
	| {
			kind: "tab";
			authed: boolean;
			authTimer: ReturnType<typeof setTimeout> | null;
	  }
	| {
			kind: "proxy";
			path: string;
			upstream: WebSocket | null;
			queue: Array<string | Buffer>;
	  };

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
	stop(): Promise<void>;
}

function rpcResult({
	id,
	result,
}: {
	id: RpcId | null;
	result: unknown;
}): RpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function rpcError({
	id,
	code,
	message,
	data,
}: {
	id: RpcId | null;
	code: number;
	message: string;
	data?: unknown;
}): RpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/**
 * The browser only ever reaches `splice` through loopback names. Checking Host
 * stops DNS-rebinding pages from talking to it under their own origin.
 */
export function isAllowedHost({
	host,
	port,
}: {
	host: string | null;
	port: number;
}): boolean {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function readCookie({
	request,
	name,
}: {
	request: Request;
	name: string;
}): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

export function isAllowedOrigin({
	origin,
	port,
}: {
	origin: string | null;
	port: number;
}): boolean {
	return (
		origin === `http://127.0.0.1:${port}` ||
		origin === `http://localhost:${port}`
	);
}

export function startServer({
	port,
	token,
	root,
	upstream,
	isUpstreamReady = () => true,
}: StartServerOptions): RunningServer {
	const bridge = new TabBridge();
	const transcription = createTranscriptionJobs({ root });
	const pauses = createPauseDetector({
		root,
		readTranscript: transcription.cached,
	});
	// What the media cookie carries: it only opens footage, never the RPC endpoint,
	// since browsers share cookies across ports on the same host. New each start.
	const mediaKey = createToken();

	async function handleRpc(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		// Browsers always send Origin on a POST. Only `splice mcp` may use this endpoint.
		if (request.headers.get("origin") !== null) {
			return new Response("Forbidden", { status: 403 });
		}
		const auth = request.headers.get("authorization");
		const bearer = auth?.startsWith("Bearer ")
			? auth.slice("Bearer ".length)
			: null;
		if (!tokensMatch({ expected: token, actual: bearer })) {
			return new Response("Unauthorized", { status: 401 });
		}
		const text = await request.text();
		if (text.length > MAX_RPC_BODY_BYTES) {
			return Response.json(
				rpcError({
					id: null,
					code: RPC_ERRORS.INVALID_REQUEST,
					message: "Request too large",
				}),
			);
		}
		const message = parseRpcMessage(text);
		if (!message || !isRpcRequest(message)) {
			return Response.json(
				rpcError({
					id: null,
					code: RPC_ERRORS.INVALID_REQUEST,
					message: "Expected a JSON-RPC request",
				}),
			);
		}
		const { id, method, params } = message;
		if (method === "footage.list") {
			try {
				return Response.json(
					rpcResult({ id, result: await listFootage({ root }) }),
				);
			} catch (error) {
				return Response.json(
					rpcError({
						id,
						code: RPC_ERRORS.INTERNAL,
						message: `Couldn't list ${root}/${FOOTAGE_FOLDER}: ${error instanceof Error ? error.message : String(error)}`,
					}),
				);
			}
		}
		if (
			method === "transcribe.start" ||
			method === "transcribe.status" ||
			method === "pauses.detect"
		) {
			try {
				const result =
					method === "transcribe.start"
						? await transcription.start(params)
						: method === "transcribe.status"
							? await transcription.status(params)
							: await pauses.detect(params);
				return Response.json(rpcResult({ id, result }));
			} catch (error) {
				return Response.json(
					rpcError({
						id,
						code:
							error instanceof BridgeError ? error.code : RPC_ERRORS.INTERNAL,
						message: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
		if (isServerMethod(method)) {
			const status: ServerStatus = {
				tabConnected: bridge.isConnected(),
				revision: bridge.getRevision(),
				root,
			};
			return Response.json(rpcResult({ id, result: status }));
		}
		if (!isTabMethod(method)) {
			return Response.json(
				rpcError({
					id,
					code: RPC_ERRORS.METHOD_NOT_FOUND,
					message: `Unknown method ${method}`,
				}),
			);
		}
		try {
			let forwarded = params;
			if (method === "editor.roughCut") {
				const resolved = await resolveRoughCutRequest({
					params,
					listSources: async (sourceParams) =>
						roughCutSourcesSchema.parse(
							await bridge.call({
								method: "editor.roughCutSources",
								params: sourceParams,
							}),
						),
					detect: pauses.detect,
					fillerCuts: pauses.fillerCuts,
				}).catch((error: unknown) => {
					throw error instanceof BridgeError
						? error
						: new BridgeError({
								code: RPC_ERRORS.INTERNAL,
								message: `Couldn't prepare the rough cut: ${error instanceof Error ? error.message : String(error)}`,
							});
				});
				if ("result" in resolved)
					return Response.json(rpcResult({ id, result: resolved.result }));
				forwarded = resolved.plan;
			}
			const result = await bridge.call({
				method,
				params: forwarded,
				// Importing probes every file, which can take minutes for long recordings.
				timeoutMs: method === "editor.importItems" ? 10 * 60_000 : undefined,
			});
			return Response.json(rpcResult({ id, result }));
		} catch (error) {
			if (error instanceof BridgeError) {
				return Response.json(
					rpcError({
						id,
						code: error.code,
						message: error.message,
						data: error.data,
					}),
				);
			}
			throw error;
		}
	}

	function hasBearerToken(request: Request): boolean {
		const auth = request.headers.get("authorization");
		return tokensMatch({
			expected: token,
			actual: auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null,
		});
	}

	/** Media accepts the bridge token (for `splice mcp` and tests) or the media cookie. */
	function isMediaAuthorized({
		request,
		port: actualPort,
	}: {
		request: Request;
		port: number;
	}): boolean {
		return (
			hasBearerToken(request) ||
			tokensMatch({
				expected: mediaKey,
				actual: readCookie({ request, name: sessionCookieName(actualPort) }),
			})
		);
	}

	/** Trades the tab's token for an HttpOnly cookie, so media elements can load footage. */
	function handleSession({
		request,
		port: actualPort,
	}: {
		request: Request;
		port: number;
	}): Response {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		if (
			!isAllowedOrigin({
				origin: request.headers.get("origin"),
				port: actualPort,
			})
		) {
			return new Response("Forbidden", { status: 403 });
		}
		if (!hasBearerToken(request)) {
			return new Response("Unauthorized", { status: 401 });
		}
		return new Response(null, {
			status: 204,
			headers: {
				"set-cookie": `${sessionCookieName(actualPort)}=${mediaKey}; Path=${BRIDGE_PATHS.media}; HttpOnly; SameSite=Strict`,
			},
		});
	}

	async function handleMedia({
		request,
		url,
		port: actualPort,
	}: {
		request: Request;
		url: URL;
		port: number;
	}): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", { status: 405 });
		}
		if (!isMediaAuthorized({ request, port: actualPort })) {
			return new Response("Unauthorized", { status: 401 });
		}
		let path: string;
		try {
			path = url.pathname
				.slice(BRIDGE_PATHS.media.length)
				.split("/")
				.map((segment) => decodeURIComponent(segment))
				.join("/");
		} catch {
			return new Response("Bad path", { status: 400 });
		}
		const contentType = mediaTypeForPath(path);
		const absolutePath = contentType
			? await resolveFootagePath({ root, path })
			: null;
		if (!contentType || !absolutePath) {
			return new Response("Not found", { status: 404 });
		}
		return serveFile({ request, absolutePath, contentType });
	}

	async function proxy({
		request,
		url,
	}: {
		request: Request;
		url: URL;
	}): Promise<Response> {
		if (!upstream) {
			return new Response("Not found", { status: 404 });
		}
		if (!isUpstreamReady()) {
			return new Response(
				"Splice is starting the editor. Reload in a few seconds.",
				{
					status: 503,
					headers: {
						"retry-after": "2",
						"content-type": "text/plain; charset=utf-8",
					},
				},
			);
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
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	}

	function handleTabMessage({
		ws,
		text,
	}: {
		ws: ServerWebSocket<SocketData>;
		text: string;
	}) {
		const data = ws.data;
		if (data.kind !== "tab") {
			return;
		}
		if (data.authed) {
			bridge.handleMessage({ socket: ws, text });
			return;
		}
		const message = parseRpcMessage(text);
		const params =
			message && isRpcRequest(message) && message.method === TAB_HELLO
				? message.params
				: null;
		const offered =
			typeof params === "object" &&
			params !== null &&
			"token" in params &&
			typeof params.token === "string"
				? params.token
				: null;
		if (
			!message ||
			!isRpcRequest(message) ||
			!tokensMatch({ expected: token, actual: offered })
		) {
			ws.close(TAB_CLOSE_CODES.UNAUTHORIZED, "Unauthorized");
			return;
		}
		data.authed = true;
		if (data.authTimer) {
			clearTimeout(data.authTimer);
			data.authTimer = null;
		}
		bridge.attach(ws);
		ws.send(
			JSON.stringify(
				rpcResult({ id: message.id, result: { server: SERVER_NAME } }),
			),
		);
	}

	function openProxySocket(ws: ServerWebSocket<SocketData>) {
		const data = ws.data;
		if (data.kind !== "proxy" || !upstream) {
			return;
		}
		const upstreamSocket = new WebSocket(
			`${upstream.replace(/^http/, "ws")}${data.path}`,
		);
		data.upstream = upstreamSocket;
		upstreamSocket.addEventListener("open", () => {
			for (const queued of data.queue) {
				upstreamSocket.send(queued);
			}
			data.queue = [];
		});
		upstreamSocket.binaryType = "arraybuffer";
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
			if (
				!isAllowedHost({ host: request.headers.get("host"), port: actualPort })
			) {
				return new Response("Forbidden host", { status: 403 });
			}
			if (url.pathname === BRIDGE_PATHS.health) {
				return Response.json({ name: SERVER_NAME, ok: true });
			}
			const isUpgrade =
				request.headers.get("upgrade")?.toLowerCase() === "websocket";
			if (url.pathname === BRIDGE_PATHS.tab) {
				if (
					!isUpgrade ||
					!isAllowedOrigin({
						origin: request.headers.get("origin"),
						port: actualPort,
					})
				) {
					return new Response("Forbidden", { status: 403 });
				}
				const upgraded = srv.upgrade(request, {
					data: { kind: "tab", authed: false, authTimer: null },
				});
				return upgraded
					? undefined
					: new Response("Upgrade failed", { status: 400 });
			}
			if (url.pathname === BRIDGE_PATHS.rpc) {
				// Imports can outlast Bun's idle timeout; the bridge call has its own deadline.
				srv.timeout(request, 0);
				return handleRpc(request);
			}
			if (url.pathname === BRIDGE_PATHS.session) {
				return handleSession({ request, port: actualPort });
			}
			if (url.pathname.startsWith(BRIDGE_PATHS.media)) {
				return handleMedia({ request, url, port: actualPort });
			}
			if (url.pathname.startsWith("/splice/")) {
				return new Response("Not found", { status: 404 });
			}
			if (isUpgrade) {
				if (
					!upstream ||
					!isAllowedOrigin({
						origin: request.headers.get("origin"),
						port: actualPort,
					})
				) {
					return new Response("Forbidden", { status: 403 });
				}
				const upgraded = srv.upgrade(request, {
					data: {
						kind: "proxy",
						path: `${url.pathname}${url.search}`,
						upstream: null,
						queue: [],
					},
				});
				return upgraded
					? undefined
					: new Response("Upgrade failed", { status: 400 });
			}
			return proxy({ request, url });
		},
		websocket: {
			open(ws) {
				if (ws.data.kind === "tab") {
					ws.data.authTimer = setTimeout(
						() => ws.close(TAB_CLOSE_CODES.UNAUTHORIZED, "No hello"),
						TAB_AUTH_TIMEOUT_MS,
					);
				} else {
					openProxySocket(ws);
				}
			},
			message(ws, message) {
				if (ws.data.kind === "tab") {
					handleTabMessage({
						ws,
						text:
							typeof message === "string" ? message : message.toString("utf8"),
					});
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
		async stop() {
			// Not awaited: in Bun 1.2 the promise never settles once a WebSocket has connected.
			void server.stop(true);
			pauses.stop();
			await transcription.stop();
		},
	};
}
