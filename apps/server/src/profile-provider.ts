import {
	profileProviderSchema,
	type ProfileProviderSettings,
} from "@splice/bridge/profile";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { invalidParams } from "./transcription";

export type ProfileProvider = (request: {
	prompt: string;
	signal: AbortSignal;
}) => Promise<unknown>;

const chatResponse = z.object({
	choices: z
		.tuple([z.object({ message: z.object({ content: z.string() }) })])
		.rest(z.unknown()),
});
const MAX_RESPONSE_BYTES = 512 * 1024;

async function readOutput(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			size += value.length;
			if (size > MAX_RESPONSE_BYTES)
				throw new Error("Profile provider output is too large.");
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		await reader.cancel();
	}
}

function parseOutput({ text, key }: { text: string; key?: string }): unknown {
	// Parse errors from a provider must never leak its response body.
	const result: unknown = JSON.parse(
		text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""),
	);
	if (key && JSON.stringify(result).includes(JSON.stringify(key).slice(1, -1)))
		throw new Error("Profile provider echoed its credential.");
	return result;
}

async function callCli({
	command,
	prompt,
	signal,
}: {
	command: "codex" | "claude";
	prompt: string;
	signal: AbortSignal;
}) {
	const cwd = await mkdtemp(join(tmpdir(), "splice-profile-"));
	try {
		const args =
			command === "codex"
				? [
						"codex",
						"exec",
						"--ephemeral",
						"--skip-git-repo-check",
						"--ignore-user-config",
						"--sandbox",
						"read-only",
						"--disable",
						"shell_tool",
						"--disable",
						"hooks",
						"--disable",
						"plugins",
						"-c",
						"mcp_servers={}",
						"-c",
						'web_search="disabled"',
						"-c",
						'approval_policy="never"',
						"-",
					]
				: [
						"claude",
						"-p",
						"--no-session-persistence",
						"--safe-mode",
						"--tools",
						"",
						"--strict-mcp-config",
						"--no-chrome",
					];
		const env = { ...process.env };
		delete env.SPLICE_PROFILE_API_KEY;
		signal.throwIfAborted();
		const child = Bun.spawn(args, {
			cwd,
			env,
			signal,
			killSignal: "SIGKILL",
			stdin: new Blob([prompt]),
			stdout: "pipe",
			stderr: "ignore",
		});
		try {
			const [output, exitCode] = await Promise.all([
				readOutput(child.stdout),
				child.exited,
			]);
			if (exitCode !== 0) throw new Error("Profile CLI failed.");
			return parseOutput({ text: output });
		} finally {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await child.exited;
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

export function createProfileProviders({
	root,
	apiKey = process.env.SPLICE_PROFILE_API_KEY,
	baseUrl = process.env.SPLICE_PROFILE_BASE_URL,
	request = fetch,
}: {
	root: string;
	apiKey?: string;
	baseUrl?: string;
	request?: (url: string, options: RequestInit) => Promise<Response>;
}) {
	const directory = join(root, "Profile");
	const path = join(directory, "provider.json");
	let writing: Promise<unknown> = Promise.resolve();

	// The endpoint and credentials are fixed for the life of the server.
	const configured = baseUrl && URL.canParse(baseUrl) ? new URL(baseUrl) : null;
	const endpoint =
		configured &&
		!configured.username &&
		!configured.password &&
		!configured.search &&
		!configured.hash &&
		(configured.protocol === "https:" ||
			(configured.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(configured.hostname)))
			? `${configured.origin}${configured.pathname.replace(/\/+$/, "")}/chat/completions`
			: null;
	const availability = { apiAvailable: endpoint !== null, hasApiKey: !!apiKey };

	async function read(): Promise<ProfileProviderSettings> {
		try {
			const stored: unknown = JSON.parse(await readFile(path, "utf8"));
			// Older settings included a browser-controlled URL. Discard it on load.
			const settings = profileProviderSchema.safeParse(
				stored &&
					typeof stored === "object" &&
					"kind" in stored &&
					stored.kind === "api" &&
					"model" in stored &&
					"baseUrl" in stored
					? { kind: "api", model: stored.model }
					: stored,
			);
			if (settings.success && !containsKey(settings.data)) return settings.data;
			throw new Error("Invalid provider settings.");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return { kind: "off" };
			throw invalidParams(
				"Profile provider settings are invalid. Save the provider again.",
			);
		}
	}

	function containsKey(provider: ProfileProviderSettings) {
		return (
			provider.kind === "api" && !!apiKey && provider.model.includes(apiKey)
		);
	}

	async function settings() {
		return { provider: await read(), ...availability };
	}

	return {
		settings,
		save(params: unknown) {
			const parsed = profileProviderSchema.safeParse(params);
			if (!parsed.success || containsKey(parsed.data))
				throw invalidParams(
					"Check the provider settings. Enter a model or enable CLI use explicitly.",
				);
			const provider = parsed.data;
			if (provider.kind === "api" && !endpoint)
				throw invalidParams(
					"Set SPLICE_PROFILE_BASE_URL in the server environment and restart Splice.",
				);
			const run = writing.then(async () => {
				await mkdir(directory, { recursive: true });
				const temporary = `${path}.tmp`;
				try {
					await writeFile(temporary, JSON.stringify(provider, null, 2), {
						mode: 0o600,
					});
					await rename(temporary, path);
				} finally {
					await rm(temporary, { force: true });
				}
				return { provider, ...availability };
			});
			writing = run.catch(() => {});
			return run;
		},
		async get(): Promise<ProfileProvider | null> {
			const provider = await read();
			if (provider.kind === "off") return null;
			if (provider.kind === "cli")
				return ({ prompt, signal }) =>
					callCli({ command: provider.command, prompt, signal });
			if (!endpoint) return null;
			return async ({ prompt, signal }) => {
				const response = await request(endpoint, {
					method: "POST",
					redirect: "error",
					headers: {
						"content-type": "application/json",
						...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
					},
					body: JSON.stringify({
						model: provider.model,
						messages: [{ role: "user", content: prompt }],
						max_tokens: 8_192,
					}),
					signal,
				});
				if (!response.ok || !response.body) {
					await response.body?.cancel();
					throw new Error("Profile API request failed.");
				}
				const parsed = chatResponse.parse(
					JSON.parse(await readOutput(response.body)),
				);
				return parseOutput({
					text: parsed.choices[0].message.content,
					key: apiKey,
				});
			};
		},
	};
}
