import { afterEach, describe, expect, test } from "bun:test";
import { BRIDGE_PATHS, RPC_ERRORS, STATE_CHANGED, TAB_CLOSE_CODES, TAB_HELLO, parseRpcMessage } from "@splice/bridge";
import { isAllowedHost, isAllowedOrigin, startServer, type RunningServer } from "../server";

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
	const server = startServer({ port: 0, token: TOKEN, root: "/tmp/splice-test", upstream });
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
	const socket = new WebSocket(`${origin.replace("http", "ws")}${BRIDGE_PATHS.tab}`, {
		headers: { Origin: originHeader },
	});
	sockets.push(socket);
	const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
	const authed = new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({ jsonrpc: "2.0", id: "hello", method: TAB_HELLO, params: { token } }));
		});
		socket.addEventListener("message", (event) => {
			const message = parseRpcMessage(String(event.data));
			if (!message) return;
			if ("id" in message && message.id === "hello") {
				resolve();
				return;
			}
			if ("method" in message && "id" in message) {
				socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method, message.params) }));
			}
		});
		socket.addEventListener("close", () => reject(new Error("closed before auth")));
	});
	authed.catch(() => {});
	return { socket, authed, closed };
}

async function rpc(origin: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
	return fetch(`${origin}${BRIDGE_PATHS.rpc}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("host and origin checks", () => {
	test("accept only loopback names on the server's port", () => {
		expect(isAllowedHost({ host: "127.0.0.1:7420", port: 7420 })).toBe(true);
		expect(isAllowedHost({ host: "localhost:7420", port: 7420 })).toBe(true);
		expect(isAllowedHost({ host: "evil.example:7420", port: 7420 })).toBe(false);
		expect(isAllowedHost({ host: "127.0.0.1:7421", port: 7420 })).toBe(false);
		expect(isAllowedOrigin({ origin: "http://127.0.0.1:7420", port: 7420 })).toBe(true);
		expect(isAllowedOrigin({ origin: "https://evil.example", port: 7420 })).toBe(false);
		expect(isAllowedOrigin({ origin: null, port: 7420 })).toBe(false);
	});
});

describe("tab connection", () => {
	test("rejects a tab from another origin", async () => {
		const server = start();
		const tab = connectTab({ origin: server.origin, originHeader: "https://evil.example" });
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
		const second = connectTab({ origin: server.origin, answer: () => "second" });
		await second.authed;
		expect(await first.closed).toBe(TAB_CLOSE_CODES.SUPERSEDED);
		const response = await rpc(server.origin, { jsonrpc: "2.0", id: 1, method: "editor.getState" });
		expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "second" });
	});
});

describe("rpc endpoint", () => {
	test("requires the token", async () => {
		const server = start();
		const body = { jsonrpc: "2.0", id: 1, method: "server.status" };
		expect((await rpc(server.origin, body, {})).status).toBe(401);
		expect((await rpc(server.origin, body, { authorization: "Bearer wrong" })).status).toBe(401);
	});

	test("refuses browser requests even with the token", async () => {
		const server = start();
		const response = await rpc(
			server.origin,
			{ jsonrpc: "2.0", id: 1, method: "server.status" },
			{ authorization: `Bearer ${TOKEN}`, origin: server.origin },
		);
		expect(response.status).toBe(403);
	});

	test("reports when no tab is connected", async () => {
		const server = start();
		const response = await rpc(server.origin, { jsonrpc: "2.0", id: 7, method: "editor.getState" });
		const body: unknown = await response.json();
		expect(body).toMatchObject({ id: 7, error: { code: RPC_ERRORS.TAB_NOT_CONNECTED } });
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
		const response = await rpc(server.origin, { jsonrpc: "2.0", id: 2, method: "editor.apply", params });
		expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true, revision: 4 } });
		expect(seen).toEqual([["editor.apply", params]]);
	});

	test("status tracks the revision the tab reports", async () => {
		const server = start();
		const tab = connectTab({ origin: server.origin });
		await tab.authed;
		tab.socket.send(JSON.stringify({ jsonrpc: "2.0", method: STATE_CHANGED, params: { revision: 12 } }));
		await Bun.sleep(50);
		const response = await rpc(server.origin, { jsonrpc: "2.0", id: 1, method: "server.status" });
		expect(await response.json()).toMatchObject({ result: { tabConnected: true, revision: 12 } });
	});

	test("rejects unknown methods", async () => {
		const server = start();
		const response = await rpc(server.origin, { jsonrpc: "2.0", id: 1, method: "fs.delete" });
		expect(await response.json()).toMatchObject({ error: { code: RPC_ERRORS.METHOD_NOT_FOUND } });
	});
});

describe("editor proxy", () => {
	test("serves editor pages from the upstream with their status", async () => {
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => new Response(`page ${new URL(request.url).pathname}`, { status: 200 }),
		});
		try {
			const server = start(`http://127.0.0.1:${upstream.port}`);
			const response = await fetch(`${server.origin}/editor/abc?x=1`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("page /editor/abc");
			expect((await fetch(`${server.origin}/splice/unknown`)).status).toBe(404);
		} finally {
			await upstream.stop(true);
		}
	});
});
