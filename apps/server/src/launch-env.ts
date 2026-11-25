import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Writes this process's environment for the `splice` it starts. Started
 * outside the agent host's job (see `startDetached`), splice doesn't inherit
 * it, and it holds SPLICE_ROOT, PATH and any profile API key. Only this user
 * can read the file, and splice deletes it as it starts.
 */
export async function writeLaunchEnv(): Promise<string> {
	const path = join(tmpdir(), `splice-launch-${randomUUID()}.json`);
	await writeFile(path, JSON.stringify(process.env), { mode: 0o600 });
	return path;
}

/**
 * Applies and deletes the environment file `--launch-env` names, and returns
 * the arguments without the option.
 */
export async function applyLaunchEnv(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
	const index = argv.indexOf("--launch-env");
	if (index === -1) return argv;
	const path = argv[index + 1];
	if (path) {
		try {
			const passed = z
				.record(z.string(), z.string())
				.parse(await Bun.file(path).json());
			for (const [key, value] of Object.entries(passed)) env[key] = value;
		} finally {
			await rm(path, { force: true });
		}
	}
	return [...argv.slice(0, index), ...argv.slice(index + 2)];
}
