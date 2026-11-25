"use client";

import { useEffect, useState } from "react";
import { profilePanelSchema } from "@splice/bridge/profile";
import { framingPreferencesSchema } from "@splice/bridge/style";
import { callSplice } from "@/bridge/splice-api";
import { useAgentBridgeStore } from "@/bridge/bridge-store";
import { PanelView } from "@/components/editor/panels/library/views/base-panel";
import { Button } from "@/components/ui/button";

const framingLabels = {
	"zoom-wider": "Wider zooms",
	"zoom-closer": "Closer zooms",
	"card-top": "Cards near the top",
	"card-bottom": "Cards near the bottom",
};

async function readPanel() {
	const [profile, framing] = await Promise.all([
		callSplice({ method: "profile.panel" }),
		callSplice({ method: "framing.list" }),
	]);
	return {
		...profilePanelSchema.parse(profile),
		framing: framingPreferencesSchema.parse(framing),
	};
}

export function ProfilePanel() {
	const connected = useAgentBridgeStore(
		(state) => state.status === "connected",
	);
	return (
		<PanelView title="Profile">
			{connected ? (
				<ProfileContents />
			) : (
				<p className="p-2 text-sm text-muted-foreground">
					Connect to Splice to view the editing profile.
				</p>
			)}
		</PanelView>
	);
}

function ProfileContents() {
	const [panel, setPanel] = useState<Awaited<ReturnType<typeof readPanel>>>();
	const [loadError, setLoadError] = useState("");
	const [actionError, setActionError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let live = true;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			try {
				const result = await readPanel();
				if (live) {
					setPanel(result);
					setLoadError("");
				}
			} catch {
				if (live) setLoadError("Could not load the editing profile.");
			} finally {
				if (live) timer = setTimeout(() => void poll(), 5_000);
			}
		}
		void poll();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, []);

	async function revert({
		kind,
		id,
	}: {
		kind: "profile" | "framing";
		id: string;
	}) {
		setBusy(true);
		setActionError("");
		try {
			if (kind === "profile") {
				await callSplice({
					method: "profile.revert",
					params: { id, operationId: crypto.randomUUID() },
				});
			} else {
				await callSplice({ method: "framing.revert", params: { id } });
			}
			setPanel(await readPanel());
		} catch (error) {
			setActionError(
				error instanceof Error
					? error.message
					: "Could not revert this update.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-4 p-2 text-sm">
			{(actionError || loadError) && (
				<p role="alert">{actionError || loadError}</p>
			)}
			{!panel && !loadError && <p>Loading profile…</p>}
			{panel && (
				<>
					<section>
						<h2 className="mb-2 font-medium">Editing profile</h2>
						<pre className="bg-muted rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
							{panel.text}
						</pre>
					</section>
					<section>
						<h2 className="font-medium">Update history</h2>
						{panel.updates.length ? (
							<>
								<p className="my-1 text-xs text-muted-foreground">
									You can revert the latest change to the profile text.
								</p>
								<ul className="divide-y">
									{panel.updates.map((update) => (
										<li
											key={update.id}
											className="flex items-center justify-between gap-2 py-2"
										>
											<div>
												<time dateTime={update.timestamp}>
													{new Date(update.timestamp).toLocaleString()}
												</time>
												<p className="text-xs text-muted-foreground">
													{update.reverts
														? "Reverted a profile update"
														: `${update.correctionCount} corrections · ${update.answerCount} answers`}
												</p>
											</div>
											{update.canRevert && (
												<Button
													size="sm"
													variant="outline"
													disabled={busy}
													onClick={() =>
														void revert({ kind: "profile", id: update.id })
													}
												>
													Revert
												</Button>
											)}
										</li>
									))}
								</ul>
							</>
						) : (
							<p className="text-muted-foreground">No updates yet.</p>
						)}
					</section>
					<section>
						<h2 className="font-medium">Framing preferences</h2>
						{panel.framing.length ? (
							<ul className="divide-y">
								{panel.framing.map((preference) => (
									<li
										key={preference.id}
										className="flex items-center justify-between gap-2 py-2"
									>
										<div>
											<p>{framingLabels[preference.kind]}</p>
											<p className="text-xs text-muted-foreground">
												{preference.reverted
													? "Reverted"
													: `${preference.evidence.length} framing corrections`}
											</p>
										</div>
										{!preference.reverted && (
											<Button
												size="sm"
												variant="outline"
												disabled={busy}
												onClick={() =>
													void revert({ kind: "framing", id: preference.id })
												}
											>
												Revert
											</Button>
										)}
									</li>
								))}
							</ul>
						) : (
							<p className="text-muted-foreground">
								No framing preferences yet.
							</p>
						)}
					</section>
				</>
			)}
		</div>
	);
}
