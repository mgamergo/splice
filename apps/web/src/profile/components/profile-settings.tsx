"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
	profileProviderSchema,
	profileSettingsSchema,
} from "@splice/bridge/profile";
import { callSplice } from "@/bridge/splice-api";
import { useAgentBridgeStore } from "@/bridge/bridge-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Settings = ReturnType<typeof profileSettingsSchema.parse>;

export function ProfileSettings() {
	const connected = useAgentBridgeStore(
		(state) => state.status === "connected",
	);
	return connected ? (
		<ProviderSettings />
	) : (
		<p className="p-3 text-sm text-muted-foreground">
			Connect to Splice to configure the profile agent.
		</p>
	);
}

function ProviderSettings() {
	const [settings, setSettings] = useState<Settings>();
	const [loading, setLoading] = useState(true);
	const [choice, setChoice] = useState("off");
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<{ error?: string; saved?: boolean }>({});

	useEffect(() => {
		let live = true;
		void callSplice({ method: "profile.settings" })
			.then((response) => {
				if (!live) return;
				const result = profileSettingsSchema.parse(response);
				setSettings(result);
				setChoice(
					result.provider.kind === "cli"
						? result.provider.command
						: result.provider.kind,
				);
			})
			.catch(() => {
				if (live)
					setStatus({
						error:
							"Could not load provider settings. Save a provider to replace them.",
					});
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, []);

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const parsed = profileProviderSchema.safeParse(
			choice === "api"
				? {
						kind: "api",
						baseUrl: form.get("baseUrl"),
						model: form.get("model"),
					}
				: choice === "off"
					? { kind: "off" }
					: {
							kind: "cli",
							command: choice,
							allowNonInteractive: form.has("allowNonInteractive"),
						},
		);
		if (!parsed.success) {
			setStatus({
				error:
					"Enter a model and a valid HTTPS or local HTTP base URL, or confirm CLI use.",
			});
			return;
		}
		setSaving(true);
		setStatus({});
		try {
			const response = await callSplice({
				method: "profile.saveSettings",
				params: parsed.data,
			});
			setSettings(profileSettingsSchema.parse(response));
			setStatus({ saved: true });
		} catch (error) {
			setStatus({
				error:
					error instanceof Error
						? error.message
						: "Could not save the provider.",
			});
		} finally {
			setSaving(false);
		}
	}

	if (loading)
		return <p className="p-3 text-sm">Loading provider settings…</p>;

	const provider = settings?.provider;
	return (
		<form
			className="space-y-3 p-3 text-sm"
			onSubmit={(event) => void save(event)}
		>
			<label className="block space-y-1">
				<span className="font-medium">Profile agent provider</span>
				<select
					value={choice}
					disabled={saving}
					className="bg-background border-input block w-full rounded-md border p-2"
					onChange={(event) => {
						setChoice(event.target.value);
						setStatus({});
					}}
				>
					<option value="off">Off</option>
					<option value="api">OpenAI-compatible API</option>
					<option value="codex">Codex CLI</option>
					<option value="claude">Claude Code CLI</option>
				</select>
			</label>
			{choice === "off" && (
				<p className="text-muted-foreground">
					Corrections stay pending for MCP processing.
				</p>
			)}
			{choice === "api" && (
				<>
					<label className="block space-y-1" htmlFor="profile-base-url">
						<span>Base URL</span>
						<Input
							id="profile-base-url"
							name="baseUrl"
							type="url"
							required
							placeholder="https://openrouter.ai/api/v1"
							defaultValue={provider?.kind === "api" ? provider.baseUrl : ""}
						/>
					</label>
					<label className="block space-y-1" htmlFor="profile-model">
						<span>Model</span>
						<Input
							id="profile-model"
							name="model"
							required
							defaultValue={provider?.kind === "api" ? provider.model : ""}
						/>
					</label>
					<p className="text-muted-foreground">
						{settings?.hasApiKey ? (
							"API key set in the Splice server."
						) : (
							<>
								For APIs that require a key, set{" "}
								<code>SPLICE_PROFILE_API_KEY</code> in the server environment
								and restart Splice.
							</>
						)}
					</p>
					<p className="text-muted-foreground">
						Splice sends profile text, correction summaries, and answers to this
						endpoint.
					</p>
				</>
			)}
			{(choice === "codex" || choice === "claude") && (
				<label key={choice} className="flex items-start gap-2">
					<input
						className="mt-1"
						type="checkbox"
						name="allowNonInteractive"
						required
						defaultChecked={
							provider?.kind === "cli" && provider.command === choice
						}
					/>
					<span>
						My CLI is signed in on this machine, and my plan and terms permit
						Splice to run it in the background.
					</span>
				</label>
			)}
			<Button size="sm" type="submit" disabled={saving}>
				{saving ? "Saving…" : "Save provider"}
			</Button>
			{status.error && <p role="alert">{status.error}</p>}
			{status.saved && <p role="status">Provider saved.</p>}
		</form>
	);
}
