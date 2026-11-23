import { TOKEN_FRAGMENT_KEY } from "@splice/bridge";
import type { SpliceConfig } from "./config";
import { isSpliceRunning } from "./mcp";
import { readSession } from "./session";

/** The link that opens the editor and hands it the bridge token. */
export function editorLink({
	port,
	token,
}: {
	port: number;
	token: string;
}): string {
	return `http://127.0.0.1:${port}/projects#${TOKEN_FRAGMENT_KEY}=${token}`;
}

/** Prints the running session's editor link, e.g. after `splice mcp` started splice in the background. */
export async function printLink({
	config,
}: {
	config: SpliceConfig;
}): Promise<void> {
	const session = await readSession({ root: config.root });
	const running = await isSpliceRunning({
		origin: `http://127.0.0.1:${config.port}`,
	});
	if (!session || !running) {
		console.error("splice isn't running. Start it with `bun run splice`.");
		process.exit(1);
	}
	console.log(editorLink({ port: session.port, token: session.token }));
}
