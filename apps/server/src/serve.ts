import { ensureFolders, type SpliceConfig } from "./config";
import { loadOrCreateToken, writeSession } from "./session";
import { startServer } from "./server";
import { startWebHost, type WebHost } from "./web-host";
import { editorLink } from "./link";
import { lockRoot } from "./root-lock";

export async function serve({
	config,
	dev,
}: {
	config: SpliceConfig;
	dev: boolean;
}): Promise<void> {
	await ensureFolders({ root: config.root });
	const releaseRoot = lockRoot({ root: config.root });
	let running: ReturnType<typeof startServer> | undefined;
	let webHost: WebHost;
	let token: string;
	try {
		token = await loadOrCreateToken({ root: config.root });
		// The public port first: if it's taken, this throws before the editor starts.
		running = startServer({
			port: config.port,
			token,
			root: config.root,
			upstream: `http://127.0.0.1:${config.port + 1}`,
			isUpstreamReady: () => webHost?.isReady() ?? false,
		});
		webHost = startWebHost({
			webDir: config.webDir,
			port: config.port + 1,
			dev,
		});
	} catch (error) {
		try {
			await running?.stop();
		} finally {
			releaseRoot();
		}
		throw error;
	}
	const host = webHost;
	const runtime = running;
	const shutdown = async (code: number) => {
		host.stop();
		try {
			await runtime.stop();
		} finally {
			releaseRoot();
			process.exit(code);
		}
	};
	let stopping = false;
	function stopForSignal() {
		if (stopping) return;
		stopping = true;
		void shutdown(0);
	}
	process.on("SIGINT", stopForSignal);
	process.on("SIGTERM", stopForSignal);

	try {
		await writeSession({
			root: config.root,
			session: {
				port: config.port,
				pid: process.pid,
				token,
				startedAt: new Date().toISOString(),
			},
		});
		await host.ready;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		if (!stopping) {
			stopping = true;
			await shutdown(1);
		}
		return;
	}
	console.log(`\nSplice is running. Data folder: ${config.root}`);
	console.log(`Open the editor: ${editorLink({ port: config.port, token })}\n`);
}
