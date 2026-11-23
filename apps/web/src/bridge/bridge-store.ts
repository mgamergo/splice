import { create } from "zustand";
import type { BridgeStatus } from "./bridge-client";

/** How long the indicator says "editing…" after the agent's last edit. */
const EDITING_WINDOW_MS = 2_000;
/** Stop survives reloads and new tabs until the creator allows the agent again. */
const BLOCKED_STORAGE_KEY = "splice-agent-blocked";

function readBlocked(): boolean {
	try {
		return globalThis.localStorage?.getItem(BLOCKED_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function writeBlocked(blocked: boolean): void {
	try {
		if (blocked) {
			globalThis.localStorage?.setItem(BLOCKED_STORAGE_KEY, "true");
		} else {
			globalThis.localStorage?.removeItem(BLOCKED_STORAGE_KEY);
		}
	} catch {
		// Without storage, Stop lasts for this page only.
	}
}

interface AgentBridgeState {
	/** "unavailable" when the tab wasn't opened from a `splice` link. */
	status: BridgeStatus | "unavailable";
	/** The creator pressed Stop: agent writes are refused until they allow them again. */
	blocked: boolean;
	/** True for a moment after each agent edit. */
	agentEditing: boolean;
	setStatus: (status: AgentBridgeState["status"]) => void;
	setBlocked: (blocked: boolean) => void;
	markEdit: () => void;
}

let editingTimer: ReturnType<typeof setTimeout> | null = null;

export const useAgentBridgeStore = create<AgentBridgeState>()((set) => ({
	status: "unavailable",
	blocked: readBlocked(),
	agentEditing: false,
	setStatus: (status) => set({ status }),
	setBlocked: (blocked) => {
		writeBlocked(blocked);
		set({ blocked });
	},
	markEdit: () => {
		if (editingTimer) clearTimeout(editingTimer);
		set({ agentEditing: true });
		editingTimer = setTimeout(() => {
			editingTimer = null;
			set({ agentEditing: false });
		}, EDITING_WINDOW_MS);
	},
}));
