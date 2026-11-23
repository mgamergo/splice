import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The folders `splice` keeps under its root, see docs/decisions.md. */
export const SPLICE_FOLDERS = [
	"Footage",
	"Projects",
	"Cache",
	"Profile",
	"Exports",
	"Tools",
] as const;

export const DEFAULT_PORT = 7420;

export interface SpliceConfig {
	/** `D:\Splice` on Windows, `~/Splice` elsewhere, or `SPLICE_ROOT`. */
	root: string;
	/** The port the creator opens; the editor's own Next.js server listens on `port + 1`. */
	port: number;
	/** The `apps/web` directory whose Next.js app `splice` hosts. */
	webDir: string;
}

export function defaultRoot({
	platform,
	home,
}: {
	platform: NodeJS.Platform;
	home: string;
}): string {
	return platform === "win32" ? "D:\\Splice" : join(home, "Splice");
}

function parsePort(value: string | undefined): number {
	if (value === undefined || value === "") {
		return DEFAULT_PORT;
	}
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65534) {
		throw new Error(
			`SPLICE_PORT must be an integer between 1 and 65534, got "${value}"`,
		);
	}
	return port;
}

export function resolveConfig(
	env: Record<string, string | undefined> = process.env,
): SpliceConfig {
	return {
		root: resolve(
			env.SPLICE_ROOT ||
				defaultRoot({ platform: process.platform, home: homedir() }),
		),
		port: parsePort(env.SPLICE_PORT),
		webDir: resolve(import.meta.dir, "../../web"),
	};
}

export async function ensureFolders({ root }: { root: string }): Promise<void> {
	await Promise.all(
		SPLICE_FOLDERS.map((folder) =>
			mkdir(join(root, folder), { recursive: true }),
		),
	);
}
