import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRIDGE_PATHS,
	MEDIA_CONTENT_HEADER,
	MEDIA_VERSION_HEADER,
	MEDIA_VERSION_PARAM,
	mediaUrlForPath,
	sessionCookieName,
} from "@splice/bridge";
import {
	footageContentHash,
	footageVersion,
	listFootage,
	mediaTypeForPath,
	resolveFootagePath,
} from "../footage";
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
	await server.stop();
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

	test("only real media extensions count, not object prototype names", () => {
		expect(mediaTypeForPath("clip.mp4")).toBe("video/mp4");
		for (const name of [
			"payload.__proto__",
			"clip.constructor",
			"x.toString",
			"noext",
		]) {
			expect(mediaTypeForPath(name)).toBeNull();
		}
	});

	test("listing includes media only, with forward-slash paths", async () => {
		const files = await listFootage({ root });
		expect(files.map((file) => file.path)).toEqual(["Day 1/take #1.mp4"]);
		expect(files[0]).toMatchObject({ size: 100, contentType: "video/mp4" });
	});
});

test("sampled fingerprints survive a copy and detect edits in the head, interior, and tail", async () => {
	const dir = await mkdtemp(join(tmpdir(), "splice-fingerprint-"));
	const original = join(dir, "recording.mp4");
	const moved = join(dir, "copy.mp4");
	const bytes = Buffer.alloc(4 * 1024 * 1024);
	const fingerprint = async (absolutePath: string) =>
		footageContentHash({
			absolutePath,
			version: await footageVersion({ absolutePath }),
		});
	try {
		await writeFile(original, bytes);
		const expected = await fingerprint(original);
		expect(expected).toMatch(/^sample-v1:[0-9a-f]{64}$/);
		await copyFile(original, moved);
		expect(await fingerprint(moved)).toBe(expected);
		for (const offset of [
			0,
			Math.floor(((bytes.length - 65536) * 15) / 31),
			bytes.length - 1,
		]) {
			const changed = Buffer.from(bytes);
			changed[offset] = 1;
			await writeFile(moved, changed);
			expect(await fingerprint(moved)).not.toBe(expected);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("media route", () => {
	test("identifies byte-identical relinks and rejects requests for a replaced version", async () => {
		const dir = join(root, "Footage");
		const original = join(dir, "before.mp4");
		const moved = join(dir, "after.mp4");
		await writeFile(original, bytes);
		try {
			const head = ({ path }: { path: string }) =>
				fetch(`${server.origin}${mediaUrlForPath(path)}`, {
					method: "HEAD",
					headers: {
						authorization: `Bearer ${TOKEN}`,
						[MEDIA_CONTENT_HEADER]: "1",
					},
				});
			const before = await head({ path: "before.mp4" });
			const hash = before.headers.get(MEDIA_CONTENT_HEADER);
			expect(hash).toHaveLength(64);

			await rename(original, moved);
			const after = await head({ path: "after.mp4" });
			const version = after.headers.get(MEDIA_VERSION_HEADER);
			expect(after.headers.get(MEDIA_CONTENT_HEADER)).toBe(hash);
			expect(version).toHaveLength(64);
			const pinned = () =>
				fetch(
					`${server.origin}${mediaUrlForPath("after.mp4")}?${MEDIA_VERSION_PARAM}=${version}`,
					{
						headers: { authorization: `Bearer ${TOKEN}`, range: "bytes=1-2" },
					},
				);
			const part = await pinned();
			expect(part.status).toBe(206);
			expect(new Uint8Array(await part.arrayBuffer())).toEqual(
				bytes.slice(1, 3),
			);

			const { atime, mtime } = await stat(moved);
			await writeFile(original, bytes.slice().reverse());
			await utimes(original, atime, mtime);
			await rename(original, moved);
			const replaced = await head({ path: "after.mp4" });
			expect(replaced.headers.get("content-length")).toBe(
				after.headers.get("content-length"),
			);
			expect(replaced.headers.get("last-modified")).toBe(
				after.headers.get("last-modified"),
			);
			expect(replaced.headers.get(MEDIA_CONTENT_HEADER)).not.toBe(hash);
			expect((await pinned()).status).toBe(412);
		} finally {
			await rm(original, { force: true });
			await rm(moved, { force: true });
		}
	});

	test("serves a file and byte ranges", async () => {
		const full = await media({ path: "Day 1/take #1.mp4" });
		expect(full.status).toBe(200);
		expect(full.headers.get("accept-ranges")).toBe("bytes");
		expect(full.headers.get("x-content-type-options")).toBe("nosniff");
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

	// Export and playback read long recordings through mediabunny's UrlSource:
	// an open-ended first read, then ranges near the clips the sequence uses.
	test("serves the ranges a ranged reader asks for, and only those bytes", async () => {
		const path = "Day 1/take #1.mp4";
		const open = await media({ path, headers: { range: "bytes=0-" } });
		expect(open.status).toBe(206);
		expect(open.headers.get("content-range")).toBe("bytes 0-99/100");
		expect(new Uint8Array(await open.arrayBuffer())).toEqual(bytes);

		const middle = await media({ path, headers: { range: "bytes=60-69" } });
		expect(middle.status).toBe(206);
		expect(middle.headers.get("content-length")).toBe("10");
		expect(new Uint8Array(await middle.arrayBuffer())).toEqual(
			bytes.slice(60, 70),
		);

		// An end past the file is cut to the file, as RFC 9110 says.
		const tail = await media({ path, headers: { range: "bytes=90-500" } });
		expect(tail.status).toBe(206);
		expect(tail.headers.get("content-range")).toBe("bytes 90-99/100");
		expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(90));

		const head = await fetch(`${server.origin}${mediaUrlForPath(path)}`, {
			method: "HEAD",
			headers: { authorization: `Bearer ${TOKEN}`, range: "bytes=10-19" },
		});
		expect(head.status).toBe(206);
		expect(head.headers.get("content-length")).toBe("10");

		for (const range of ["bytes=20-10", "bytes=0-1,5-6", "items=0-5"]) {
			const refused = await media({ path, headers: { range } });
			expect(refused.status).toBe(416);
			expect(refused.headers.get("content-range")).toBe("bytes */100");
		}
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
