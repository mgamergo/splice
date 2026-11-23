import { ensureFolders, type SpliceConfig } from "./config";
import { loadOrCreateToken, writeSession } from "./session";
import { startServer } from "./server";
import { startWebHost, type WebHost } from "./web-host";
import { editorLink } from "./link";

export async function serve({
	config,
	dev,
}: {
	config: SpliceConfig;
	dev: boolean;
}): Promise<void> {
	await ensureFolders({ root: config.root });
	const token = await loadOrCreateToken({ root: config.root });
	let webHost: WebHost | null = null;
	// The public port first: if it's taken, this throws before the editor starts.
	const running = startServer({
		port: config.port,
		token,
		root: config.root,
		upstream: `http://127.0.0.1:${config.port + 1}`,
		isUpstreamReady: () => webHost?.isReady() ?? false,
	});
	try {
		webHost = startWebHost({
			webDir: config.webDir,
			port: config.port + 1,
			dev,
		});
	} catch (error) {
		running.stop();
		throw error;
	}
	const host = webHost;
	await writeSession({
		root: config.root,
		session: {
			port: config.port,
			pid: process.pid,
			token,
			startedAt: new Date().toISOString(),
		},
	});

	const shutdown = () => {
		host.stop();
		running.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	try {
		await host.ready;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		host.stop();
		running.stop();
		process.exit(1);
	}
	console.log(`\nSplice is running. Data folder: ${config.root}`);
	console.log(`Open the editor: ${editorLink({ port: config.port, token })}\n`);
}
