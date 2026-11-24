import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	BRIDGE_PATHS,
	denoisedAudioUrlForPath,
	RPC_ERRORS,
	STATE_CHANGED,
	TAB_CLOSE_CODES,
	TAB_HELLO,
	TAB_METHODS,
	parseRpcMessage,
} from "@splice/bridge";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcClient, isLongMethod, rpcDeadlineMs } from "../rpc-client";
import {
	isAllowedHost,
	isAllowedOrigin,
	startServer,
	tabCallTimeoutMs,
	type RunningServer,
} from "../server";
import * as sharedWork from "../shared-work";
import { DEFAULT_CALL_TIMEOUT_MS } from "../tab-bridge";

const TOKEN = "test-token";
const running: RunningServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) {
		socket.close();
	}
	for (const server of running.splice(0)) {
		await server.stop();
	}
});

function start(upstream: string | null = null) {
	const server = startServer({
		port: 0,
		token: TOKEN,
		root: "/tmp/splice-test",
		upstream,
	});
	running.push(server);
	return server;
}

type Answer = (method: string, params: unknown) => unknown;

/** A fake editor tab that answers requests with `answer`. */
function connectTab({
	origin,
	token = TOKEN,
	originHeader = origin,
	answer = () => null,
}: {
	origin: string;
	token?: string;
	originHeader?: string;
	answer?: Answer;
}) {
	const socket = new WebSocket(
		`${origin.replace("http", "ws")}${BRIDGE_PATHS.tab}`,
		{
			headers: { Origin: originHeader },
		},
	);
	sockets.push(socket);
	const closed = new Promise<number>((resolve) =>
		socket.addEventListener("close", (event) => resolve(event.code)),
	);
	const authed = new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => {
			socket.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "hello",
					method: TAB_HELLO,
					params: { token },
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			const message = parseRpcMessage(String(event.data));
			if (!message) return;
			if ("id" in message && message.id === "hello") {
				resolve();
				return;
			}
			if ("method" in message && "id" in message) {
				socket.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						result: answer(message.method, message.params),
					}),
				);
			}
		});
		socket.addEventListener("close", () =>
			reject(new Error("closed before auth")),
		);
	});
	authed.catch(() => {});
	return { socket, authed, closed };
}

async function rpc({
	origin,
	body,
	headers = { authorization: `Bearer ${TOKEN}` },
}: {
	origin: string;
	body: unknown;
	headers?: Record<string, string>;
}) {
	return fetch(`${origin}${BRIDGE_PATHS.rpc}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

/**
 * Footage/talk.wav and a fake FFmpeg whose silence scan takes `seconds`, then
 * finds one silence from 1 to 2 s.
 */
async function writeSlowScan({
	root,
	seconds,
}: {
	root: string;
	seconds: number;
}) {
	await mkdir(join(root, "Footage"));
	await Bun.write(join(root, "Footage", "talk.wav"), "");
	const ffmpeg = join(root, "Tools", "ffmpeg");
	await Bun.write(
		ffmpeg,
		[
			"#!/bin/sh",
			'case "$*" in',
			`*silencedetect*) sleep ${seconds}`,
			'  echo "[silencedetect @ 0x1] silence_start: 1" >&2',
			'  echo "[silencedetect @ 0x1] silence_end: 2 | silence_duration: 1" >&2 ;;',
			'*) echo "  Duration: 00:00:05.00, start: 0.000000" >&2',
			'  echo "  Stream #0:0: Audio: pcm_s16le, 48000 Hz, mono" >&2 ;;',
			"esac",
			"",
		].join("\n"),
	);
	await chmod(ffmpeg, 0o755);
}

/**
 * Runs `body` against a splice whose fake FFmpeg stalls in a pause scan or a
 * noise-reduction scan after writing its process ID, for a recording
 * Footage/talk.wav.
 */
async function withStallingFfmpeg(
	body: (context: {
		server: RunningServer;
		scanPid: () => Promise<number>;
		isRunning: (pid: number) => boolean;
	}) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "splice-hang-up-"));
	const pidFile = join(root, "scan.pid");
	const isRunning = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	try {
		await mkdir(join(root, "Footage"));
		await Bun.write(join(root, "Footage", "talk.wav"), "");
		const ffmpeg = join(root, "Tools", "ffmpeg");
		await Bun.write(
			ffmpeg,
			[
				"#!/bin/sh",
				'case "$*" in',
				`*silencedetect*|*astats*) echo $$ > '${pidFile}'; exec sleep 60 ;;`,
				'*) echo "  Duration: 00:00:05.00, start: 0.000000" >&2',
				'  echo "  Stream #0:0: Audio: pcm_s16le, 48000 Hz, mono" >&2 ;;',
				"esac",
				"",
			].join("\n"),
		);
		await chmod(ffmpeg, 0o755);
		const server = startServer({ port: 0, token: TOKEN, root, upstream: null });
		running.push(server);
		await body({
			server,
			isRunning,
			async scanPid() {
				let pid = 0;
				for (let tries = 0; !pid && tries < 100; tries++) {
					await Bun.sleep(50);
					pid = Number(
						await Bun.file(pidFile)
							.text()
							.catch(() => "0"),
					);
				}
				return pid;
			},
		});
	} finally {
		// Leave no fake FFmpeg behind, even when an assertion failed.
		const pid = Number(
			await Bun.file(pidFile)
				.text()
				.catch(() => "0"),
		);
		if (pid && isRunning(pid)) process.kill(pid);
		await rm(root, { recursive: true, force: true });
	}
}

function rpcCall({
	server,
	method,
	params,
	signal,
}: {
	server: RunningServer;
	method: string;
	params: unknown;
	signal: AbortSignal;
}) {
	const call = fetch(`${server.origin}${BRIDGE_PATHS.rpc}`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal,
	});
	call.catch(() => {});
	return call;
}

/** Whether the process exits within 5 s. */
async function stopped({
	pid,
	isRunning,
}: {
	pid: number;
	isRunning: (pid: number) => boolean;
}) {
	for (let tries = 0; isRunning(pid) && tries < 100; tries++)
		await Bun.sleep(50);
	return !isRunning(pid);
}

describe("host and origin checks", () => {
	test("accept only loopback names on the server's port", () => {
		expect(isAllowedHost({ host: "127.0.0.1:7420", port: 7420 })).toBe(true);
		expect(isAllowedHost({ host: "localhost:7420", port: 7420 })).toBe(true);
		expect(isAllowedHost({ host: "evil.example:7420", port: 7420 })).toBe(
			false,
		);
		expect(isAllowedHost({ host: "127.0.0.1:7421", port: 7420 })).toBe(false);
		expect(
			isAllowedOrigin({ origin: "http://127.0.0.1:7420", port: 7420 }),
		).toBe(true);
		expect(
			isAllowedOrigin({ origin: "https://evil.example", port: 7420 }),
		).toBe(false);
		expect(isAllowedOrigin({ origin: null, port: 7420 })).toBe(false);
	});
});

describe("tab connection", () => {
	test("rejects a tab from another origin", async () => {
		const server = start();
		const tab = connectTab({
			origin: server.origin,
			originHeader: "https://evil.example",
		});
		await expect(tab.authed).rejects.toThrow();
		expect(server.bridge.isConnected()).toBe(false);
	});

	test("closes a tab that offers the wrong token", async () => {
		const server = start();
		const tab = connectTab({ origin: server.origin, token: "wrong" });
		expect(await tab.closed).toBe(TAB_CLOSE_CODES.UNAUTHORIZED);
		expect(server.bridge.isConnected()).toBe(false);
	});

	test("a newer tab takes over from the previous one", async () => {
		const server = start();
		const first = connectTab({ origin: server.origin, answer: () => "first" });
		await first.authed;
		const second = connectTab({
			origin: server.origin,
			answer: () => "second",
		});
		await second.authed;
		expect(await first.closed).toBe(TAB_CLOSE_CODES.SUPERSEDED);
		const response = await rpc({
			origin: server.origin,
			body: { jsonrpc: "2.0", id: 1, method: "editor.getState" },
		});
		expect(await response.json()).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: "second",
		});
	});
});

describe("rpc endpoint", () => {
	test("requires the token", async () => {
		const server = start();
		const body = { jsonrpc: "2.0", id: 1, method: "server.status" };
		expect(
			(await rpc({ origin: server.origin, body, headers: {} })).status,
		).toBe(401);
		expect(
			(
				await rpc({
					origin: server.origin,
					body,
					headers: { authorization: "Bearer wrong" },
				})
			).status,
		).toBe(401);
	});

	test("refuses browser requests even with the token", async () => {
		const server = start();
		const response = await rpc({
			origin: server.origin,
			body: { jsonrpc: "2.0", id: 1, method: "server.status" },
			headers: { authorization: `Bearer ${TOKEN}`, origin: server.origin },
		});
		expect(response.status).toBe(403);
	});

	test("reports when no tab is connected", async () => {
		const server = start();
		const response = await rpc({
			origin: server.origin,
			body: { jsonrpc: "2.0", id: 7, method: "editor.getState" },
		});
		const body: unknown = await response.json();
		expect(body).toMatchObject({
			id: 7,
			error: { code: RPC_ERRORS.TAB_NOT_CONNECTED },
		});
	});

	test("relays editor calls to the tab and back", async () => {
		const server = start();
		const seen: Array<[string, unknown]> = [];
		const tab = connectTab({
			origin: server.origin,
			answer: (method, params) => {
				seen.push([method, params]);
				return { ok: true, revision: 4 };
			},
		});
		await tab.authed;
		const params = { expectedRevision: 3, label: "Cut", ops: [] };
		const response = await rpc({
			origin: server.origin,
			body: { jsonrpc: "2.0", id: 2, method: "editor.apply", params },
		});
		expect(await response.json()).toEqual({
			jsonrpc: "2.0",
			id: 2,
			result: { ok: true, revision: 4 },
		});
		expect(seen).toEqual([["editor.apply", params]]);
	});

	test("a rough cut's plan pass returns its tightening, and the apply pass cuts it", async () => {
		const server = start();
		const seen: Array<[string, unknown]> = [];
		const tab = connectTab({
			origin: server.origin,
			answer: (method, params) => {
				seen.push([method, params]);
				return { ok: true, revision: 3 };
			},
		});
		await tab.authed;
		const request = {
			expectedRevision: 3,
			sections: [],
			pauses: [{ projectItemId: "a", sourceIn: 4, sourceOut: 5 }],
		};
		const tightening = { pauses: request.pauses, fillerWords: [] };
		const plan = await rpc({
			origin: server.origin,
			body: {
				jsonrpc: "2.0",
				id: 1,
				method: "editor.roughCut",
				params: { ...request, plan: true },
			},
		});
		expect(await plan.json()).toMatchObject({
			result: { ok: true, revision: 3, tightening },
		});
		const sourceGains = [{ projectItemId: "a", gainDb: 2 }];
		const applied = await rpc({
			origin: server.origin,
			body: {
				jsonrpc: "2.0",
				id: 2,
				method: "editor.roughCut",
				params: {
					...request,
					pauses: [],
					sourceGains,
					tightening,
				},
			},
		});
		expect(await applied.json()).toEqual({
			jsonrpc: "2.0",
			id: 2,
			result: { ok: true, revision: 3 },
		});
		expect(seen.map(([, params]) => params)).toEqual([
			{
				...request,
				falseStarts: [],
				pausePaddingSeconds: 0.2,
				fillerWords: [],
				plan: true,
			},
			{
				...request,
				falseStarts: [],
				pausePaddingSeconds: 0.2,
				fillerWords: [],
				sourceGains,
			},
		]);
	});

	test("answers a rough cut whose pause scan outlasts the idle timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-slow-scan-"));
		try {
			// The silence scan stays quiet for 6 s, long past the 1 s idle
			// timeout. The RPC endpoint is exempt from it; the rough cut still
			// answers through the client `splice mcp` uses.
			await writeSlowScan({ root, seconds: 6 });
			const server = startServer({
				port: 0,
				token: TOKEN,
				root,
				upstream: null,
				idleTimeoutSeconds: 1,
			});
			running.push(server);
			const tab = connectTab({
				origin: server.origin,
				answer: (method) =>
					method === "editor.roughCutSources"
						? {
								ok: true,
								sequenceId: "raw",
								items: [{ id: "a", name: "talk.wav", path: "talk.wav" }],
							}
						: { ok: true, revision: 3 },
			});
			await tab.authed;
			const call = createRpcClient({ origin: server.origin, token: TOKEN });
			const started = performance.now();
			expect(
				await call({
					method: "editor.roughCut",
					params: { expectedRevision: 3, sections: [], plan: true },
				}),
			).toEqual({
				ok: true,
				revision: 3,
				tightening: {
					pauses: [{ projectItemId: "a", sourceIn: 1, sourceOut: 2 }],
					fillerWords: [],
					sequenceId: "raw",
				},
			});
			expect(performance.now() - started).toBeGreaterThan(5_000);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);

	test("refuses to cut on a tab that connected while the pauses were found", async () => {
		const root = await mkdtemp(join(tmpdir(), "splice-tab-swap-"));
		try {
			await writeSlowScan({ root, seconds: 2 });
			const server = startServer({
				port: 0,
				token: TOKEN,
				root,
				upstream: null,
			});
			running.push(server);
			const { promise: listed, resolve: onListed } =
				Promise.withResolvers<void>();
			const measured = connectTab({
				origin: server.origin,
				answer: (method) => {
					if (method !== "editor.roughCutSources")
						return { ok: true, revision: 3 };
					onListed();
					return {
						ok: true,
						sequenceId: "raw",
						items: [{ id: "a", name: "talk.wav", path: "talk.wav" }],
					};
				},
			});
			await measured.authed;
			const call = createRpcClient({ origin: server.origin, token: TOKEN });
			const cut = call({
				method: "editor.roughCut",
				params: { expectedRevision: 3, sections: [] },
			});
			cut.catch(() => {});
			await listed;
			// Same revision, but its sequences and unsaved edits weren't measured.
			const asked: string[] = [];
			const other = connectTab({
				origin: server.origin,
				answer: (method) => {
					asked.push(method);
					return { ok: true, revision: 3 };
				},
			});
			await other.authed;
			await expect(cut).rejects.toThrow("Another editor tab connected");
			expect(asked).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);

	test.each([
		["a pause scan", "pauses.detect", {}],
		["a noise-reduction render", "noiseReduction.render", {}],
		[
			"the render a cold measurement waits for",
			"loudness.measure",
			{ noiseReduction: true },
		],
	])(
		"stops %s when its caller hangs up",
		(_name: string, method: string, params: object) =>
			withStallingFfmpeg(async ({ server, scanPid, isRunning }) => {
				const hangUp = new AbortController();
				const call = rpcCall({
					server,
					method,
					params: { path: "talk.wav", ...params },
					signal: hangUp.signal,
				});
				const pid = await scanPid();
				expect(isRunning(pid)).toBe(true);

				hangUp.abort();
				await expect(call).rejects.toThrow();
				expect(await stopped({ pid, isRunning })).toBe(true);
			}),
		20_000,
	);

	test("a render RPC and a media request share one render, stopped once both hang up", async () => {
		// Counts requests that joined shared work, so the RPC leaves only
		// once the media request waits on the render too.
		let joined = 0;
		const create = sharedWork.createSharedWork;
		const counting: typeof create = <T,>(options: { stop: AbortSignal }) => {
			const shared = create<T>(options);
			return {
				...shared,
				run: (request) => {
					joined++;
					return shared.run(request);
				},
			};
		};
		const spy = spyOn(sharedWork, "createSharedWork").mockImplementation(
			counting,
		);
		try {
			await withStallingFfmpeg(async ({ server, scanPid, isRunning }) => {
				const rpcHangUp = new AbortController();
				const mediaHangUp = new AbortController();
				const render = rpcCall({
					server,
					method: "noiseReduction.render",
					params: { path: "talk.wav" },
					signal: rpcHangUp.signal,
				});
				const pid = await scanPid();
				const media = fetch(
					`${server.origin}${denoisedAudioUrlForPath("talk.wav")}`,
					{
						headers: { authorization: `Bearer ${TOKEN}` },
						signal: mediaHangUp.signal,
					},
				);
				media.catch(() => {});
				for (let tries = 0; joined < 2 && tries < 100; tries++)
					await Bun.sleep(50);
				expect(joined).toBe(2);

				rpcHangUp.abort();
				await expect(render).rejects.toThrow();
				// The media request still waits, so the render runs on.
				await Bun.sleep(300);
				expect(isRunning(pid)).toBe(true);

				mediaHangUp.abort();
				await expect(media).rejects.toThrow();
				expect(await stopped({ pid, isRunning })).toBe(true);
			});
		} finally {
			spy.mockRestore();
		}
	}, 20_000);

	test("the tab gets as long to answer a long call as splice mcp waits for it", async () => {
		for (const method of TAB_METHODS)
			expect(tabCallTimeoutMs(method)).toBe(
				isLongMethod(method) ? rpcDeadlineMs(method) : DEFAULT_CALL_TIMEOUT_MS,
			);
		expect(tabCallTimeoutMs("editor.importItems")).toBe(30 * 60_000);
		expect(tabCallTimeoutMs("editor.getState")).toBe(30_000);

		const server = start();
		const tab = connectTab({
			origin: server.origin,
			answer: (method) =>
				method === "editor.importItems"
					? { items: [], failed: [] }
					: { ok: true },
		});
		await tab.authed;
		const relayed = spyOn(server.bridge, "call");
		const call = createRpcClient({ origin: server.origin, token: TOKEN });
		await call({ method: "editor.importItems", params: { paths: ["a.wav"] } });
		await call({ method: "editor.getState" });
		expect(
			relayed.mock.calls.map(([{ method, timeoutMs }]) => [method, timeoutMs]),
		).toEqual([
			["editor.importItems", rpcDeadlineMs("editor.importItems")],
			["editor.getState", DEFAULT_CALL_TIMEOUT_MS],
		]);
	});

	test("status tracks the revision the tab reports", async () => {
		const server = start();
		const tab = connectTab({ origin: server.origin });
		await tab.authed;
		tab.socket.send(
			JSON.stringify({
				jsonrpc: "2.0",
				method: STATE_CHANGED,
				params: { revision: 12 },
			}),
		);
		await Bun.sleep(50);
		const response = await rpc({
			origin: server.origin,
			body: { jsonrpc: "2.0", id: 1, method: "server.status" },
		});
		expect(await response.json()).toMatchObject({
			result: { tabConnected: true, revision: 12 },
		});
	});

	test("rejects unknown methods", async () => {
		const server = start();
		const response = await rpc({
			origin: server.origin,
			body: { jsonrpc: "2.0", id: 1, method: "fs.delete" },
		});
		expect(await response.json()).toMatchObject({
			error: { code: RPC_ERRORS.METHOD_NOT_FOUND },
		});
	});
});

describe("editor proxy", () => {
	test("serves editor pages from the upstream with their status", async () => {
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) =>
				new Response(`page ${new URL(request.url).pathname}`, { status: 200 }),
		});
		try {
			const server = start(`http://127.0.0.1:${upstream.port}`);
			const response = await fetch(`${server.origin}/editor/abc?x=1`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("page /editor/abc");
			expect((await fetch(`${server.origin}/splice/unknown`)).status).toBe(404);
		} finally {
			void upstream.stop(true);
		}
	});
});
