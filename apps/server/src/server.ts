import {
	MEDIA_CONTENT_HEADER,
	MEDIA_VERSION_HEADER,
	MEDIA_VERSION_PARAM,
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
	type TabMethod,
} from "@splice/bridge";
import {
	type RoughCutTightening,
	roughCutSourcesSchema,
} from "@splice/bridge/ops";
import {
	EXPORT_FILE_KINDS,
	isTabApiMethod,
	type TabApiMethod,
} from "@splice/bridge/delivery";
import type { Server, ServerWebSocket } from "bun";
import {
	FOOTAGE_FOLDER,
	footageContentHash,
	footageVersion,
	listFootage,
	mediaTypeForPath,
	resolveFootagePath,
	serveFile,
} from "./footage";
import { createPauseDetector } from "./pauses";
import { resolveRoughCutRequest } from "./rough-cut";
import { createToken, tokensMatch } from "./session";
import { isLongMethod, rpcDeadlineMs } from "./rpc-client";
import {
	BridgeError,
	DEFAULT_CALL_TIMEOUT_MS,
	TabBridge,
	type TabSocket,
} from "./tab-bridge";
import { createLoudnessMeter } from "./loudness";
import { createNoiseReducer, wantsDenoisedAudio } from "./noise-reduction";
import { createTranscriptionJobs } from "./transcription";
import { createExportStore, type OpenFolder } from "./exports";
import { createProfileStore } from "./profile";
import { createStyleProfile } from "./style-profile";
import { createSpellingStore } from "./spellings";

const TAB_AUTH_TIMEOUT_MS = 5_000;
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
const EXPORT_UPLOAD_PATH = new RegExp(
	`^${BRIDGE_PATHS.api}/exports/([0-9a-f-]{36})/(${EXPORT_FILE_KINDS.join("|")})$`,
);

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
	/** Seconds a connection may sit idle. RPC requests are exempt. Tests shorten it. */
	idleTimeoutSeconds?: number;
	/** How Open folder shows the Exports folder. Tests replace it. */
	openFolder?: OpenFolder;
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

/**
 * How long the tab may take to answer a call relayed from `splice mcp`. A
 * long method, such as an import probing every file, waits as long as
 * `splice mcp` does, so the bridge never gives up on work its caller still
 * waits for.
 */
export function tabCallTimeoutMs(method: TabMethod): number {
	return isLongMethod(method) ? rpcDeadlineMs(method) : DEFAULT_CALL_TIMEOUT_MS;
}

export function startServer({
	port,
	token,
	root,
	upstream,
	isUpstreamReady = () => true,
	idleTimeoutSeconds = 120,
	openFolder,
}: StartServerOptions): RunningServer {
	const bridge = new TabBridge();
	const transcription = createTranscriptionJobs({ root });
	const pauses = createPauseDetector({
		root,
		readTranscript: transcription.cached,
	});
	const noiseReduction = createNoiseReducer({ root });
	const loudness = createLoudnessMeter({ root, noiseReduction });
	const exportStore = createExportStore({ root, openFolder });
	const spellings = createSpellingStore({ root });
	const profile = createProfileStore({ root });
	const style = createStyleProfile({ root });
	/** What the editor tab may ask of `splice` itself. */
	const tabApi: Record<TabApiMethod, (params: unknown) => Promise<unknown>> = {
		"footage.list": () => listFootage({ root }),
		"transcript.words": (params) => transcription.words(params),
		"profile.capture": (params) => profile.capture(params),
		"style.defaults": style.defaults,
		"framing.list": style.listFraming,
		"framing.reconcile": style.reconcileFraming,
		"spellings.list": () => spellings.list(),
		"spellings.save": (params) => spellings.save(params),
		"spellings.remove": (params) => spellings.remove(params),
		"exports.list": (params) => exportStore.list(params),
		"exports.begin": (params) => exportStore.begin(params),
		"exports.publish": (params) => exportStore.publish(params),
		"exports.abort": (params) => exportStore.abort(params),
		"exports.open": () => exportStore.open(),
	};
	// `signal` aborts when the caller hangs up, so FFmpeg work nobody waits
	// for stops.
	const serverJobs = new Map<
		string,
		(request: { params: unknown; signal: AbortSignal }) => Promise<unknown>
	>([
		["transcribe.start", ({ params }) => transcription.start(params)],
		["transcribe.status", ({ params }) => transcription.status(params)],
		["transcript.words", ({ params }) => transcription.words(params)],
		["loudness.measure", (request) => loudness.measure(request)],
		["pauses.detect", (request) => pauses.detect(request)],
		["noiseReduction.render", (request) => noiseReduction.render(request)],
		["profile.read", () => profile.read()],
		["profile.pending", ({ params }) => profile.pending(params)],
		["profile.apply", ({ params }) => profile.apply(params)],
		["style.defaults", style.defaults],
		["style.setDefaults", ({ params }) => style.setDefaults(params)],
		["framing.list", style.listFraming],
		["framing.revert", ({ params }) => style.revertFraming(params)],
		["exports.list", ({ params }) => exportStore.list(params)],
	]);
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
		const job = serverJobs.get(method);
		if (job) {
			try {
				const result = await job({ params, signal: request.signal });
				return Response.json(rpcResult({ id, result }));
			} catch (error) {
				return errorResponse({ id, error });
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
			let tightening: RoughCutTightening | undefined;
			if (method === "editor.roughCut") {
				let measuredTab: TabSocket | null | undefined;
				const resolved = await resolveRoughCutRequest({
					params,
					listSources: async (sourceParams) => {
						measuredTab = bridge.currentTab();
						return roughCutSourcesSchema.parse(
							await bridge.call({
								method: "editor.roughCutSources",
								params: sourceParams,
							}),
						);
					},
					pauseRanges: (scan) =>
						pauses.pauseRanges({ ...scan, signal: request.signal }),
					fillerCuts: (scan) =>
						pauses.fillerCuts({ ...scan, signal: request.signal }),
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
				// A tab that connected during the scan can hold the same sequence
				// and revision with different edits, so only the measured tab cuts.
				if (measuredTab !== undefined && bridge.currentTab() !== measuredTab)
					throw new BridgeError({
						code: RPC_ERRORS.TAB_DISCONNECTED,
						message:
							"Another editor tab connected while Splice found the pauses, so nothing was cut. Run rough_cut again.",
					});
				forwarded = resolved.plan;
				tightening = resolved.tightening;
			}
			const result = await bridge.call({
				method,
				params: forwarded,
				timeoutMs: tabCallTimeoutMs(method),
			});
			return Response.json(
				rpcResult({
					id,
					// The apply pass sends these back to cut what the plan measured.
					result:
						tightening && typeof result === "object" && result !== null
							? { ...result, tightening }
							: result,
				}),
			);
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

	function errorResponse({
		id,
		error,
	}: {
		id: RpcId | null;
		error: unknown;
	}): Response {
		return Response.json(
			rpcError({
				id,
				code: error instanceof BridgeError ? error.code : RPC_ERRORS.INTERNAL,
				message: error instanceof Error ? error.message : String(error),
				data: error instanceof BridgeError ? error.data : undefined,
			}),
		);
	}

	/**
	 * The editor tab's calls to `splice`: JSON-RPC posted to `BRIDGE_PATHS.api`,
	 * and export files put to `<api>/exports/<id>/<kind>`. Like the session
	 * endpoint, they need the editor's origin and the bridge token.
	 */
	async function handleTabApi({
		request,
		url,
		port: actualPort,
	}: {
		request: Request;
		url: URL;
		port: number;
	}): Promise<Response> {
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
		const upload = EXPORT_UPLOAD_PATH.exec(url.pathname);
		if (upload) {
			if (request.method !== "PUT")
				return new Response("Method not allowed", { status: 405 });
			const kind = EXPORT_FILE_KINDS.find((value) => value === upload[2]);
			const offset = Number(url.searchParams.get("offset") ?? 0);
			if (!kind || !Number.isSafeInteger(offset) || offset < 0)
				return new Response("Bad upload", { status: 400 });
			try {
				const result = await exportStore.write({
					exportId: upload[1],
					kind,
					offset,
					body: request.body,
				});
				return Response.json(rpcResult({ id: null, result }));
			} catch (error) {
				return errorResponse({ id: null, error });
			}
		}
		if (url.pathname !== BRIDGE_PATHS.api)
			return new Response("Not found", { status: 404 });
		if (request.method !== "POST")
			return new Response("Method not allowed", { status: 405 });
		const text = await request.text();
		const message =
			text.length <= MAX_RPC_BODY_BYTES ? parseRpcMessage(text) : null;
		if (!message || !isRpcRequest(message))
			return Response.json(
				rpcError({
					id: null,
					code: RPC_ERRORS.INVALID_REQUEST,
					message: "Expected a JSON-RPC request",
				}),
			);
		const { id, method, params } = message;
		if (!isTabApiMethod(method))
			return Response.json(
				rpcError({
					id,
					code: RPC_ERRORS.METHOD_NOT_FOUND,
					message: `Unknown method ${method}`,
				}),
			);
		try {
			return Response.json(
				rpcResult({ id, result: await tabApi[method](params) }),
			);
		} catch (error) {
			return errorResponse({ id, error });
		}
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
		const denoised = wantsDenoisedAudio(url);
		const expected = url.searchParams.get(MEDIA_VERSION_PARAM);
		const probe = request.method === "HEAD" && !denoised;
		const changed = () =>
			new Response("The recording changed on disk.", { status: 412 });
		let version: string | undefined;
		let contentHash: string | undefined;
		if (expected !== null || probe) {
			try {
				version = await footageVersion({ absolutePath });
				if (expected !== null && expected !== version) return changed();
				if (probe && request.headers.get(MEDIA_CONTENT_HEADER) === "1")
					contentHash = await footageContentHash({ absolutePath, version });
				// The path can be replaced while a content hash is computed.
				if ((await footageVersion({ absolutePath })) !== version)
					return changed();
			} catch {
				return changed();
			}
		}
		if (!denoised) {
			const response = serveFile({ request, absolutePath, contentType });
			if (version) response.headers.set(MEDIA_VERSION_HEADER, version);
			if (contentHash) response.headers.set(MEDIA_CONTENT_HEADER, contentHash);
			return response;
		}
		try {
			const { file } = await noiseReduction.ensure({
				path,
				signal: request.signal,
			});
			if (version && (await footageVersion({ absolutePath })) !== version)
				return changed();
			return serveFile({
				request,
				absolutePath: file,
				contentType: "audio/wav",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return new Response(`Couldn't reduce noise: ${message}`, {
				// Invalid params: not a recording, e.g. an image.
				status: error instanceof BridgeError ? 400 : 500,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}
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
		idleTimeout: idleTimeoutSeconds,
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
				// Imports and a rough cut's uncached pause scans send nothing until
				// they finish, which can outlast Bun's idle timeout. Bridge calls have
				// their own deadlines, `splice mcp` gives each call one, and an FFmpeg
				// scan stops once no caller waits for it.
				srv.timeout(request, 0);
				return handleRpc(request);
			}
			if (url.pathname === BRIDGE_PATHS.session) {
				return handleSession({ request, port: actualPort });
			}
			if (
				url.pathname === BRIDGE_PATHS.api ||
				url.pathname.startsWith(`${BRIDGE_PATHS.api}/`)
			) {
				// An export's MP4 can take a while to stream in.
				srv.timeout(request, 0);
				return handleTabApi({ request, url, port: actualPort });
			}
			if (url.pathname.startsWith(BRIDGE_PATHS.media)) {
				// The first request for denoised audio renders it, which takes a while.
				if (
					wantsDenoisedAudio(url) ||
					request.headers.get(MEDIA_CONTENT_HEADER) === "1"
				)
					srv.timeout(request, 0);
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

	void profile.initialize().catch((error) => {
		console.error("Couldn't initialize the editing profile:", error);
	});

	return {
		server,
		bridge,
		origin: `http://127.0.0.1:${server.port}`,
		async stop() {
			// Not awaited: in Bun 1.2 the promise never settles once a WebSocket has connected.
			void server.stop(true);
			await Promise.all([
				pauses.stop(),
				transcription.stop(),
				exportStore.stop(),
				profile.stop(),
				loudness.stop(),
				noiseReduction.stop(),
			]);
		},
	};
}
