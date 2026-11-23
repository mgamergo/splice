import { TOKEN_FRAGMENT_KEY } from "@splice/bridge";
import { ensureFolders, type SpliceConfig } from "./config";
import { loadOrCreateToken, writeSession } from "./session";
import { startServer } from "./server";
import { startWebHost } from "./web-host";

export async function serve({ config, dev }: { config: SpliceConfig; dev: boolean }): Promise<void> {
	await ensureFolders({ root: config.root });
	const token = await loadOrCreateToken({ root: config.root });
	const webHost = startWebHost({ webDir: config.webDir, port: config.port + 1, dev });
	const running = startServer({
		port: config.port,
		token,
		root: config.root,
		upstream: webHost.origin,
		isUpstreamReady: () => webHost.isReady(),
	});
	await writeSession({
		root: config.root,
		session: { port: config.port, pid: process.pid, token, startedAt: new Date().toISOString() },
	});

	const shutdown = () => {
		webHost.stop();
		running.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	try {
		await webHost.ready;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		running.stop();
		process.exit(1);
	}
	console.log(`\nSplice is running. Data folder: ${config.root}`);
	console.log(`Open the editor: ${running.origin}/projects#${TOKEN_FRAGMENT_KEY}=${token}\n`);
}
