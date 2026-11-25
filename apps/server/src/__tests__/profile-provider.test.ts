import type { ProfileProviderSettings } from "@splice/bridge/profile";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileProviders } from "../profile-provider";

test("keeps the API key in the authorization header and rejects provider output that echoes it", async () => {
	const root = await mkdtemp(join(tmpdir(), "splice-provider-"));
	const key = "test-key-used-only-on-the-server";
	const provider: ProfileProviderSettings = {
		kind: "api",
		model: "test-model",
	};
	const providers = createProfileProviders({
		root,
		apiKey: key,
		baseUrl: "https://example.test/v1/",
		async request(url, init) {
			expect(url).toBe("https://example.test/v1/chat/completions");
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				`Bearer ${key}`,
			);
			expect(init?.redirect).toBe("error");
			expect(init?.body).not.toContain(key);
			return Response.json({
				choices: [{ message: { content: JSON.stringify({ text: key }) } }],
			});
		},
	});
	try {
		expect(await providers.get()).toBeNull();
		expect(() => providers.save({ kind: "cli", command: "codex" })).toThrow(
			"enable CLI use explicitly",
		);
		expect(() => providers.save({ ...provider, apiKey: key })).toThrow(
			"Check the provider settings",
		);
		expect(() => providers.save({ ...provider, model: key })).toThrow(
			"Check the provider settings",
		);
		expect(await providers.save(provider)).toEqual({
			provider,
			hasApiKey: true,
			apiAvailable: true,
		});
		expect(await providers.settings()).toEqual({
			provider,
			hasApiKey: true,
			apiAvailable: true,
		});
		expect(
			await readFile(join(root, "Profile", "provider.json"), "utf8"),
		).not.toContain(key);
		expect(() =>
			providers.save({ ...provider, baseUrl: "https://unconfigured.test/v1" }),
		).toThrow("Check the provider settings");
		// Legacy settings on disk cannot select the credential destination either.
		await writeFile(
			join(root, "Profile", "provider.json"),
			JSON.stringify({ ...provider, baseUrl: "https://unconfigured.test/v1" }),
		);
		const unconfigured = createProfileProviders({
			root,
			apiKey: key,
			baseUrl: "",
		});
		expect(await unconfigured.get()).toBeNull();
		const call = await providers.get();
		if (!call) throw new Error("Expected an API provider");
		await expect(
			call({
				prompt: "profile evidence",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("echoed its credential");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
