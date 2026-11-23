import { create } from "zustand";
import type { BridgeStatus } from "./bridge-client";

/** How long the indicator says "editing…" after the agent's last edit. */
const EDITING_WINDOW_MS = 2_000;
/** Stop survives reloads and new tabs until the creator allows the agent again. */
export const BLOCKED_STORAGE_KEY = "splice-agent-blocked";

/** Browser storage, or null while pre-rendering on the server (Node 25 warns on touching it there). */
function getStorage(): Storage | null {
	return typeof window === "undefined" ? null : window.localStorage;
}

/** The Stop flag shared by every tab, or null when storage is unavailable. */
function readStoredBlocked(): boolean | null {
	try {
		const storage = getStorage();
		return storage ? storage.getItem(BLOCKED_STORAGE_KEY) === "true" : null;
	} catch {
		return null;
	}
}

/**
 * Whether agent writes are refused right now. Either source can stop the agent:
 * the shared flag (Stop pressed in another tab) or this tab's own state (Stop
 * pressed here even if storage refused the write).
 */
export function isAgentBlocked(): boolean {
	return readStoredBlocked() === true || useAgentBridgeStore.getState().blocked;
}

/** Whether the write succeeded. */
function writeBlocked(blocked: boolean): boolean {
	try {
		if (blocked) {
			getStorage()?.setItem(BLOCKED_STORAGE_KEY, "true");
		} else {
			getStorage()?.removeItem(BLOCKED_STORAGE_KEY);
		}
		return true;
	} catch {
		return false;
	}
}

/** A Stop pressed in this page that storage refused to keep; it holds until Allow or reload. */
let unsavedStop = false;

interface AgentBridgeState {
	/** "unavailable" when the tab wasn't opened from a `splice` link. */
	status: BridgeStatus | "unavailable";
	/** The creator pressed Stop: agent writes are refused until they allow them again. */
	blocked: boolean;
	/** True for a moment after each agent edit. */
	agentEditing: boolean;
	setStatus: (status: AgentBridgeState["status"]) => void;
	setBlocked: (blocked: boolean) => void;
	/** Picks up a Stop or Allow pressed in another tab. */
	syncBlocked: () => void;
	markEdit: () => void;
}

let editingTimer: ReturnType<typeof setTimeout> | null = null;

export const useAgentBridgeStore = create<AgentBridgeState>()((set) => ({
	status: "unavailable",
	blocked: readStoredBlocked() ?? false,
	agentEditing: false,
	setStatus: (status) => set({ status }),
	setBlocked: (blocked) => {
		unsavedStop = !writeBlocked(blocked) && blocked;
		set({ blocked });
	},
	syncBlocked: () => {
		const stored = readStoredBlocked();
		if (stored !== null) set({ blocked: stored || unsavedStop });
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
