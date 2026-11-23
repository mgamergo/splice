"use client";

import { BRIDGE_PATHS } from "@splice/bridge";
import { useEffect } from "react";
import { EditorApi } from "@/agent/editor-api";
import { EditorCore } from "@/core";
import { AgentBridgeClient } from "./bridge-client";
import { useAgentBridgeStore } from "./bridge-store";
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
			handlers: createTabHandlers({ editor, api, isBlocked: () => useAgentBridgeStore.getState().blocked }),
			onStatus: store.setStatus,
			onRequest: (method) => {
				if (method === "editor.apply" && !useAgentBridgeStore.getState().blocked) {
					store.markEdit();
				}
			},
		});

		let lastRevision: number | null = null;
		const reportRevision = () => {
			const revision = api.getRevision();
			if (revision !== lastRevision) {
				lastRevision = revision;
				client.notifyRevision(revision);
			}
		};
		const unsubscribers = [editor.timeline.subscribe(reportRevision), editor.sequences.subscribe(reportRevision)];
		client.start();
		reportRevision();

		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
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
