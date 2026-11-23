"use client";

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
import { captureBridgeToken, readBridgeToken } from "./token";

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
			onStatus: store.setStatus,
			onRequest: (method) => {
				if (method === "editor.apply" && !isAgentBlocked()) {
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
		editor.command.advanceRevisionTo({ revision: Date.now() });
		const unsubscribe = editor.command.subscribeRevision((revision) =>
			client.notifyRevision(revision),
		);
		client.start();
		client.notifyRevision(api.getRevision());

		return () => {
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
	}, []);
}
