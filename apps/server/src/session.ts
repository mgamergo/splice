import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What a running `splice` publishes so `splice mcp` can find and authenticate
 * to it. Lives in `Cache`, so deleting the cache only costs the tab a fresh link.
 */
export interface SessionInfo {
	port: number;
	pid: number;
	token: string;
	startedAt: string;
}

export function sessionPath({ root }: { root: string }): string {
	return join(root, "Cache", "session.json");
}

export async function readSession({
	root,
}: {
	root: string;
}): Promise<SessionInfo | null> {
	try {
		const value: unknown = JSON.parse(
			await readFile(sessionPath({ root }), "utf8"),
		);
		if (
			typeof value === "object" &&
			value !== null &&
			"token" in value &&
			"port" in value &&
			"pid" in value &&
			"startedAt" in value &&
			typeof value.token === "string" &&
			typeof value.port === "number" &&
			typeof value.pid === "number" &&
			typeof value.startedAt === "string"
		) {
			return {
				token: value.token,
				port: value.port,
				pid: value.pid,
				startedAt: value.startedAt,
			};
		}
		return null;
	} catch {
		return null;
	}
}

export async function writeSession({
	root,
	session,
}: {
	root: string;
	session: SessionInfo;
}): Promise<void> {
	await writeFile(
		sessionPath({ root }),
		`${JSON.stringify(session, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

export function createToken(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Reuses the previous run's token, so an open editor tab reconnects on its own
 * after `splice` restarts.
 */
export async function loadOrCreateToken({
	root,
}: {
	root: string;
}): Promise<string> {
	return (await readSession({ root }))?.token ?? createToken();
}

export function tokensMatch({
	expected,
	actual,
}: {
	expected: string;
	actual: string | null | undefined;
}): boolean {
	if (typeof actual !== "string") {
		return false;
	}
	const a = Buffer.from(expected);
	const b = Buffer.from(actual);
	return a.length === b.length && timingSafeEqual(a, b);
}
