#!/usr/bin/env bun
import { resolveConfig } from "./config";
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

async function main(argv: string[]) {
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

await main(process.argv.slice(2));
