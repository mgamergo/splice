#!/usr/bin/env bun
import { resolveConfig } from "./config";
import { applyLaunchEnv } from "./launch-env";
import { runMcp } from "./mcp";
import { serve } from "./serve";
import { printLink } from "./link";

const USAGE = `Usage:
  splice [serve] [--dev]   Start the local server and the editor
  splice mcp               Run the MCP server on stdio (started by your agent)
  splice link              Print the editor link of the running splice

Environment:
  SPLICE_ROOT   Data folder (default D:\\Splice on Windows, ~/Splice elsewhere)
  SPLICE_PORT   Port to open in the browser (default 7420; the editor uses the next one)`;

/**
 * Bun picks its HTTP proxy from the environment when it starts and doesn't exempt
 * loopback, so with a proxy set, every request to splice itself would go to the proxy.
 * Relaunch once with loopback in NO_PROXY.
 */
async function relaunchWithoutProxyForLoopback(): Promise<boolean> {
	const env = process.env;
	const hasProxy = [
		env.HTTP_PROXY,
		env.http_proxy,
		env.HTTPS_PROXY,
		env.https_proxy,
	].some(Boolean);
	const noProxy = env.NO_PROXY ?? env.no_proxy ?? "";
	const entries = noProxy.split(",").map((entry) => entry.trim());
	if (!hasProxy || entries.includes("127.0.0.1")) {
		return false;
	}
	const value = [...entries.filter(Boolean), "127.0.0.1", "localhost"].join(
		",",
	);
	const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
		env: { ...env, NO_PROXY: value, no_proxy: value },
		stdio: ["inherit", "inherit", "inherit"],
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => child.kill(signal));
	}
	process.exit(await child.exited);
}

/**
 * The oldest Bun Splice runs on. 1.2 crashes whisper's CPU fallback on
 * Windows, which only shows deep into a transcription.
 */
const MINIMUM_BUN = "1.4.2";

async function main(input: string[]) {
	if (Bun.semver.order(Bun.version, MINIMUM_BUN) < 0) {
		console.error(
			`Splice needs Bun ${MINIMUM_BUN} or later; this is Bun ${Bun.version}. Run \`bun upgrade\` and start it again.`,
		);
		process.exit(1);
	}
	const argv = await applyLaunchEnv(input);
	// A relaunch below repeats the arguments; the file is gone by then.
	process.argv = [...process.argv.slice(0, 2), ...argv];
	if (await relaunchWithoutProxyForLoopback()) {
		return;
	}
	// `splice --dev` means `splice serve --dev`.
	const [command = "serve", ...rest] =
		argv[0]?.startsWith("-") && !["-h", "--help"].includes(argv[0])
			? ["serve", ...argv]
			: argv;
	const config = resolveConfig();
	switch (command) {
		case "serve":
			await serve({ config, dev: rest.includes("--dev") });
			return;
		case "link":
			await printLink({ config });
			return;
		case "mcp":
			await runMcp({ config });
			return;
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return;
		default:
			console.error(`Unknown command "${command}"\n\n${USAGE}`);
			process.exit(2);
	}
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
