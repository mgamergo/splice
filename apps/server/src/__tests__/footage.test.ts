import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRIDGE_PATHS,
	mediaUrlForPath,
	sessionCookieName,
} from "@splice/bridge";
import { listFootage, resolveFootagePath } from "../footage";
import { startServer, type RunningServer } from "../server";

const TOKEN = "test-token";
let root: string;
let server: RunningServer;
const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "splice-footage-"));
	await mkdir(join(root, "Footage", "Day 1"), { recursive: true });
	await writeFile(join(root, "Footage", "Day 1", "take #1.mp4"), bytes);
	await writeFile(join(root, "Footage", "notes.txt"), "not media");
	await writeFile(join(root, "secret.mp4"), "outside");
	await symlink(join(root, "secret.mp4"), join(root, "Footage", "escape.mp4"));
	await mkdir(join(root, "Footage", "folder.mp4"));
	server = startServer({ port: 0, token: TOKEN, root, upstream: null });
});

afterAll(async () => {
	server.stop();
	await rm(root, { recursive: true, force: true });
});

const media = ({
	path,
	headers = {},
}: {
	path: string;
	headers?: Record<string, string>;
}) =>
	fetch(`${server.origin}${mediaUrlForPath(path)}`, {
		headers: { authorization: `Bearer ${TOKEN}`, ...headers },
	});

describe("footage paths", () => {
	test("resolve inside Footage and refuse anything that escapes it", async () => {
		expect(
			await resolveFootagePath({ root, path: "Day 1/take #1.mp4" }),
		).toEndWith("take #1.mp4");
		for (const path of [
			"../secret.mp4",
			"Day 1/../../secret.mp4",
			"escape.mp4",
			"/etc/passwd",
			"Day 1\\..\\..\\secret.mp4",
			"",
		]) {
			expect(await resolveFootagePath({ root, path })).toBeNull();
		}
	});

	test("listing includes media only, with forward-slash paths", async () => {
		const files = await listFootage({ root });
		expect(files.map((file) => file.path)).toEqual(["Day 1/take #1.mp4"]);
		expect(files[0]).toMatchObject({ size: 100, contentType: "video/mp4" });
	});
});

describe("media route", () => {
	test("serves a file and byte ranges", async () => {
		const full = await media({ path: "Day 1/take #1.mp4" });
		expect(full.status).toBe(200);
		expect(full.headers.get("accept-ranges")).toBe("bytes");
		expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

		const part = await media({
			path: "Day 1/take #1.mp4",
			headers: { range: "bytes=10-19" },
		});
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe("bytes 10-19/100");
		expect(new Uint8Array(await part.arrayBuffer())).toEqual(
			bytes.slice(10, 20),
		);

		const suffix = await media({
			path: "Day 1/take #1.mp4",
			headers: { range: "bytes=-5" },
		});
		expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(95));

		expect(
			(
				await media({
					path: "Day 1/take #1.mp4",
					headers: { range: "bytes=200-" },
				})
			).status,
		).toBe(416);
	});

	test("refuses requests without the token or cookie, and paths outside Footage", async () => {
		const url = `${server.origin}${mediaUrlForPath("Day 1/take #1.mp4")}`;
		expect((await fetch(url)).status).toBe(401);
		// The cookie carries a media-only key, never the bridge token.
		expect(
			(
				await fetch(url, {
					headers: {
						cookie: `${sessionCookieName(server.server.port ?? 0)}=${TOKEN}`,
					},
				})
			).status,
		).toBe(401);
		expect((await media({ path: "escape.mp4" })).status).toBe(404);
		expect(
			(
				await fetch(`${server.origin}${BRIDGE_PATHS.media}..%2Fsecret.mp4`, {
					headers: { authorization: `Bearer ${TOKEN}` },
				})
			).status,
		).toBe(404);
		expect((await media({ path: "notes.txt" })).status).toBe(404);
		expect((await media({ path: "folder.mp4" })).status).toBe(404);
	});

	test("the session endpoint sets the cookie only for the editor's origin with the token", async () => {
		const session = (headers: Record<string, string>) =>
			fetch(`${server.origin}${BRIDGE_PATHS.session}`, {
				method: "POST",
				headers,
			});
		expect(
			(
				await session({
					origin: "https://evil.example",
					authorization: `Bearer ${TOKEN}`,
				})
			).status,
		).toBe(403);
		expect(
			(await session({ origin: server.origin, authorization: "Bearer wrong" }))
				.status,
		).toBe(401);
		const ok = await session({
			origin: server.origin,
			authorization: `Bearer ${TOKEN}`,
		});
		expect(ok.status).toBe(204);
		const cookie = ok.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain(`Path=${BRIDGE_PATHS.media}`);
		expect(cookie).not.toContain(TOKEN);
		expect(
			cookie.startsWith(`${sessionCookieName(server.server.port ?? 0)}=`),
		).toBe(true);
		const key = cookie.split(";")[0];
		const url = `${server.origin}${mediaUrlForPath("Day 1/take #1.mp4")}`;
		expect((await fetch(url, { headers: { cookie: key } })).status).toBe(200);
		// The media key opens footage only, never the RPC endpoint.
		const rpc = await fetch(`${server.origin}${BRIDGE_PATHS.rpc}`, {
			method: "POST",
			headers: { authorization: `Bearer ${key.split("=")[1]}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server.status" }),
		});
		expect(rpc.status).toBe(401);
	});
});
