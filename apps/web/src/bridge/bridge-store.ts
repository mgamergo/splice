import { create } from "zustand";
import type { BridgeStatus } from "./bridge-client";

/** How long the indicator says "editing…" after the agent's last edit. */
const EDITING_WINDOW_MS = 2_000;

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
	blocked: false,
	agentEditing: false,
	setStatus: (status) => set({ status }),
	setBlocked: (blocked) => set({ blocked }),
	markEdit: () => {
		if (editingTimer) clearTimeout(editingTimer);
		set({ agentEditing: true });
		editingTimer = setTimeout(() => {
			editingTimer = null;
			set({ agentEditing: false });
		}, EDITING_WINDOW_MS);
	},
}));
