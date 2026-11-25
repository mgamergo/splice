"use client";

import { watchFramingCorrections } from "@/agent/style-profile";
import { BRIDGE_PATHS } from "@splice/bridge";
import { useEffect } from "react";
import { EditorApi } from "@/agent/editor-api";
import { EditorCore } from "@/core";
import { AgentBridgeClient } from "./bridge-client";
import {
	BLOCKED_STORAGE_KEY,
	isAgentBlocked,
	useAgentBridgeStore,
} from "./bridge-store";
import { createTabHandlers } from "./handlers";
import { ensureMediaSession } from "./media-session";
import { captureBridgeToken, readBridgeToken } from "./token";

/** The highest revision any tab of this editor has used, so revisions only grow across reloads. */
const REVISION_FLOOR_KEY = "splice-revision-floor";

function readRevisionFloor(): number {
	try {
		return Number(window.localStorage.getItem(REVISION_FLOOR_KEY)) || 0;
	} catch {
		return 0;
	}
}

function recordRevisionFloor(revision: number): void {
	try {
		if (revision > readRevisionFloor()) {
			window.localStorage.setItem(REVISION_FLOOR_KEY, String(revision));
		}
	} catch {
		// Without storage, the clock seed alone separates page loads.
	}
}

/** Connects this editor tab to `splice` for as long as the editor is mounted. */
export function useAgentBridge(): void {
	useEffect(() => {
		captureBridgeToken();
		const token = readBridgeToken();
		const store = useAgentBridgeStore.getState();
		if (!token) {
			store.setStatus("unavailable");
			return;
		}
		void ensureMediaSession();
		const editor = EditorCore.getInstance();
		const api = new EditorApi(editor);
		const scheme = window.location.protocol === "https:" ? "wss" : "ws";
		const client = new AgentBridgeClient({
			url: `${scheme}://${window.location.host}${BRIDGE_PATHS.tab}`,
			token,
			handlers: createTabHandlers({
				editor,
				api,
				isBlocked: isAgentBlocked,
			}),
			onStatus: (status) => {
				store.setStatus(status);
				// A restarted splice has a new media key.
				if (status === "connected") void ensureMediaSession();
			},
			onRequest: (method) => {
				if (
					(method === "editor.apply" ||
						method === "editor.rawSequence" ||
						method === "editor.roughCut") &&
					!isAgentBlocked()
				) {
					store.markEdit();
				}
			},
		});

		store.syncBlocked();
		const onStorage = (event: StorageEvent) => {
			if (event.key === BLOCKED_STORAGE_KEY || event.key === null)
				store.syncBlocked();
		};
		window.addEventListener("storage", onStorage);
		// A revision the agent read before a reload must never match one after it,
		// even if the clock stepped back in between.
		editor.command.advanceRevisionTo({
			revision: Math.max(Date.now(), readRevisionFloor() + 1),
		});
		recordRevisionFloor(api.getRevision());
		const unsubscribe = editor.command.subscribeRevision((revision) => {
			recordRevisionFloor(revision);
			client.notifyRevision(revision);
		});
		const stopWatchingFraming = watchFramingCorrections({ editor });
		client.start();
		client.notifyRevision(api.getRevision());

		return () => {
			stopWatchingFraming();
			unsubscribe();
			window.removeEventListener("storage", onStorage);
			client.stop();
			store.setStatus("unavailable");
		};
	}, []);
}

/** Captures a token handed over on any page, e.g. the project list `splice` links to. */
export function useCaptureBridgeToken(): void {
	useEffect(() => {
		captureBridgeToken();
		void ensureMediaSession();
	}, []);
}
