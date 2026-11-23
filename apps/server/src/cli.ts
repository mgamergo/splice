#!/usr/bin/env bun
import { resolveConfig } from "./config";
import { runMcp } from "./mcp";
import { serve } from "./serve";

const USAGE = `Usage:
  splice [serve] [--dev]   Start the local server and the editor
  splice mcp               Run the MCP server on stdio (started by your agent)

Environment:
  SPLICE_ROOT   Data folder (default D:\\Splice on Windows, ~/Splice elsewhere)
  SPLICE_PORT   Port to open in the browser (default 7420; the editor uses the next one)`;

async function main(argv: string[]) {
	const [command = "serve", ...rest] = argv;
	const config = resolveConfig();
	switch (command) {
		case "serve":
			await serve({ config, dev: rest.includes("--dev") });
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
