import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

export interface WebHost {
	origin: string;
	isReady(): boolean;
	/** Resolves once the editor answers, rejects if its process exits first. */
	ready: Promise<void>;
	stop(): void;
}

const READY_TIMEOUT_MS = 120_000;

/**
 * Runs the editor's Next.js server on a private loopback port. `splice`
 * proxies it, so the tab, the bridge and project media share one origin.
 */
export function startWebHost({
	webDir,
	port,
	dev,
}: {
	webDir: string;
	port: number;
	dev: boolean;
}): WebHost {
	if (!dev && !existsSync(join(webDir, ".next", "BUILD_ID"))) {
		throw new Error(
			"The editor isn't built yet. Run `bun run build:web` once, or start with `splice serve --dev`.",
		);
	}
	const origin = `http://127.0.0.1:${port}`;
	const args = [
		"bun",
		"run",
		"next",
		dev ? "dev" : "start",
		...(dev ? ["--turbopack"] : []),
		"--hostname",
		"127.0.0.1",
		"--port",
		String(port),
	];
	const child: Subprocess = Bun.spawn(args, {
		cwd: webDir,
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, PORT: String(port) },
	});

	let ready = false;
	let stopped = false;
	const readyPromise = (async () => {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (stopped || child.exitCode !== null) {
				throw new Error(
					`The editor server exited (code ${child.exitCode ?? "unknown"})`,
				);
			}
			try {
				await fetch(`${origin}/`, { redirect: "manual" });
				ready = true;
				return;
			} catch {
				await Bun.sleep(250);
			}
		}
		throw new Error(
			`The editor server didn't start within ${READY_TIMEOUT_MS / 1000} s`,
		);
	})();

	return {
		origin,
		isReady: () => ready,
		ready: readyPromise,
		stop() {
			stopped = true;
			child.kill();
		},
	};
}
