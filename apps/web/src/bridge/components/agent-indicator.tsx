"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import { useAgentBridgeStore } from "../bridge-store";

const LABELS = {
	connecting: "Connecting to Splice…",
	connected: "Agent connected",
	unauthorized: "Agent link expired",
	superseded: "Agent is using another tab",
} as const;

const HINTS = {
	connecting: "Waiting for the splice server. Start it with `bun run splice`.",
	connected: "An agent can read and edit this sequence. Your edits always win.",
	unauthorized: "Open the link splice printed when it started to reconnect.",
	superseded:
		"Another editor tab took over the agent connection. Reload this tab to take it back.",
} as const;

/** Shows whether an agent is connected and lets the creator stop its edits. */
export function AgentIndicator() {
	const status = useAgentBridgeStore((state) => state.status);
	const blocked = useAgentBridgeStore((state) => state.blocked);
	const setBlocked = useAgentBridgeStore((state) => state.setBlocked);
	const editing = useAgentBridgeStore((state) => state.agentEditing);

	if (status === "unavailable") return null;

	const label =
		blocked && status === "connected"
			? "Agent stopped"
			: editing && status === "connected"
				? "Agent editing…"
				: LABELS[status];

	return (
		<div
			className="flex items-center gap-2 text-xs"
			data-testid="agent-indicator"
			data-status={status}
			data-blocked={blocked}
		>
			<span className="flex items-center gap-1.5" title={HINTS[status]}>
				<span
					aria-hidden
					className={cn(
						"size-2 rounded-full",
						status === "connected" && !blocked && "bg-emerald-500",
						status === "connected" && editing && !blocked && "animate-pulse",
						status === "connected" && blocked && "bg-amber-500",
						status === "connecting" && "bg-muted-foreground animate-pulse",
						(status === "unauthorized" || status === "superseded") &&
							"bg-destructive",
					)}
				/>
				<span
					className="text-muted-foreground sr-only md:not-sr-only"
					role="status"
				>
					{label}
				</span>
			</span>
			{status === "connected" && (
				<Button
					variant="outline"
					size="sm"
					className="h-7 gap-1 px-2 text-xs"
					aria-label={blocked ? "Allow agent" : "Stop agent"}
					onClick={() => setBlocked(!blocked)}
				>
					{blocked ? "Allow" : "Stop"}
					<span className="hidden sm:inline">agent</span>
				</Button>
			)}
		</div>
	);
}
