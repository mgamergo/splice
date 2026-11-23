import { create } from "zustand";
import type { BridgeStatus } from "./bridge-client";

interface AgentBridgeState {
	/** "unavailable" when the tab wasn't opened from a `splice` link. */
	status: BridgeStatus | "unavailable";
	/** The creator pressed Stop: agent writes are refused until they allow them again. */
	blocked: boolean;
	/** When the agent last applied an edit, for the "editing…" indicator. */
	lastEditAt: number | null;
	setStatus: (status: AgentBridgeState["status"]) => void;
	setBlocked: (blocked: boolean) => void;
	markEdit: () => void;
}

export const useAgentBridgeStore = create<AgentBridgeState>()((set) => ({
	status: "unavailable",
	blocked: false,
	lastEditAt: null,
	setStatus: (status) => set({ status }),
	setBlocked: (blocked) => set({ blocked }),
	markEdit: () => set({ lastEditAt: Date.now() }),
}));
