import { afterEach, describe, expect, test } from "bun:test";
import {
	RPC_ERRORS,
	STATE_CHANGED,
	TAB_CLOSE_CODES,
	TAB_HELLO,
} from "@splice/bridge";
import {
	AgentBridgeClient,
	type BridgeSocket,
	type BridgeStatus,
} from "../bridge-client";
import { AgentBlockedError, type TabHandlers } from "../handlers";

type Listener = (event: never) => void;

class FakeSocket implements BridgeSocket {
	readyState = 0;
	sent: unknown[] = [];
	private listeners = new Map<string, Listener[]>();

	// Mirrors the WebSocket API.
	// eslint-disable-next-line opencut/prefer-object-params
	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}

	close() {
		this.emitClose(1000);
	}

	open() {
		this.readyState = 1;
		this.emit({ type: "open", event: {} });
	}

	receive(message: unknown) {
		this.emit({ type: "message", event: { data: JSON.stringify(message) } });
	}

	emitClose(code: number) {
		this.readyState = 3;
		this.emit({ type: "close", event: { code } });
	}

	private emit({ type, event }: { type: string; event: object }) {
		for (const listener of this.listeners.get(type) ?? [])
			(listener as (event: object) => void)(event);
	}
}

const clients: AgentBridgeClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.stop();
});

function setUp(handlers: Partial<TabHandlers> = {}) {
	const sockets: FakeSocket[] = [];
	const statuses: BridgeStatus[] = [];
	const client = new AgentBridgeClient({
		url: "ws://127.0.0.1:7420/splice/tab",
		token: "secret",
		handlers: {
			"editor.getState": () => ({ revision: 3 }),
			"editor.apply": () => ({ ok: true }),
			"editor.listItems": () => [],
			"editor.importItems": () => ({ imported: [], failed: [] }),
			"editor.rawSequence": () => ({ ok: true }),
			"editor.addCaptions": () => ({ ok: true }),
			"editor.captionCues": () => ({ ok: true, cues: [] }),
			"editor.correctCaption": () => ({ ok: true }),
			"editor.styleUpdatePreview": () => ({ ok: true }),
			"editor.styleUpdateApply": () => ({ ok: true }),
			"editor.graphicsPlan": () => ({ ok: true, graphics: [] }),
			"editor.shortStyle": () => ({ ok: true }),
			"editor.shortHook": () => ({ ok: true }),
			"editor.shortCaptionPlacement": () => ({ ok: true }),
			"editor.shortSrt": () => ({ ok: true, srt: "" }),
			"editor.graphicsApply": () => ({ ok: true, graphics: [] }),
			"editor.graphicsList": () => ({ ok: true, graphics: [] }),
			"editor.finalizeCut": () => ({ ok: true }),
			"editor.checkpointStatus": () => ({ ok: true }),
			"editor.checkpointCompare": () => ({ ok: true }),
			"editor.issuesList": () => ({ ok: true, issues: [] }),
			"editor.dismissIssue": () => ({ ok: true }),
			"editor.cutTranscript": () => ({ ok: true, paragraphs: [] }),
			"editor.transcriptSelection": () => ({ ok: true, selection: null }),
			"editor.roughCut": () => ({ ok: true }),
			"editor.roughCutSources": () => ({ ok: true, items: [] }),
			"editor.takesList": () => ({ ok: true, markers: [] }),
			"editor.audioSources": () => ({ ok: true, audioSources: [] }),
			"editor.addMusic": () => ({ ok: true }),
			"editor.updateMusic": () => ({ ok: true }),
			"editor.removeMusic": () => ({ ok: true }),
			"editor.mixLoudness": () => ({ ok: true }),
			"editor.mixStatus": () => ({ ok: true }),
			...handlers,
		},
		onStatus: (status) => statuses.push(status),
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
	});
	clients.push(client);
	client.start();
	const connect = () => {
		const socket = sockets[sockets.length - 1];
		socket.open();
		socket.receive({
			jsonrpc: "2.0",
			id: "hello",
			result: { server: "splice" },
		});
		return socket;
	};
	return { client, sockets, statuses, connect };
}

describe("AgentBridgeClient", () => {
	test("says hello with the token, then reports the revision", () => {
		const { client, sockets, statuses, connect } = setUp();
		client.notifyRevision(5);
		const socket = connect();
		expect(sockets[0].sent[0]).toEqual({
			jsonrpc: "2.0",
			id: "hello",
			method: TAB_HELLO,
			params: { token: "secret" },
		});
		expect(socket.sent[1]).toEqual({
			jsonrpc: "2.0",
			method: STATE_CHANGED,
			params: { revision: 5 },
		});
		expect(statuses).toEqual(["connecting", "connected"]);
	});

	test("answers requests through the handlers", async () => {
		const { connect } = setUp();
		const socket = connect();
		socket.receive({ jsonrpc: "2.0", id: 9, method: "editor.getState" });
		await Bun.sleep(0);
		expect(socket.sent.at(-1)).toEqual({
			jsonrpc: "2.0",
			id: 9,
			result: { revision: 3 },
		});
	});

	test("reports a stopped agent as AGENT_BLOCKED", async () => {
		const { connect } = setUp({
			"editor.apply": () => {
				throw new AgentBlockedError();
			},
		});
		const socket = connect();
		socket.receive({
			jsonrpc: "2.0",
			id: 1,
			method: "editor.apply",
			params: {},
		});
		await Bun.sleep(0);
		expect(socket.sent.at(-1)).toMatchObject({
			id: 1,
			error: { code: RPC_ERRORS.AGENT_BLOCKED },
		});
	});

	test("refuses methods the tab doesn't offer", async () => {
		const { connect } = setUp();
		const socket = connect();
		socket.receive({ jsonrpc: "2.0", id: 1, method: "fs.read" });
		await Bun.sleep(0);
		expect(socket.sent.at(-1)).toMatchObject({
			id: 1,
			error: { code: RPC_ERRORS.METHOD_NOT_FOUND },
		});
	});

	test("reconnects after splice goes away", async () => {
		const { sockets, connect } = setUp();
		connect().emitClose(1006);
		await Bun.sleep(600);
		expect(sockets).toHaveLength(2);
	});

	test("stops reconnecting when the token is refused or another tab takes over", async () => {
		for (const code of [
			TAB_CLOSE_CODES.UNAUTHORIZED,
			TAB_CLOSE_CODES.SUPERSEDED,
		]) {
			const { sockets, statuses, connect } = setUp();
			connect().emitClose(code);
			await Bun.sleep(600);
			expect(sockets).toHaveLength(1);
			expect(statuses.at(-1)).toBe(
				code === TAB_CLOSE_CODES.UNAUTHORIZED ? "unauthorized" : "superseded",
			);
		}
	});
});
