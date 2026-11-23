import { spawn } from "node:child_process";

/** Quotes a value for a single-quoted PowerShell string. */
function powershellQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Starts a process that outlives the one starting it. Agent hosts restart MCP
 * servers by killing their whole process tree, which would take a plain child
 * with it. On Windows, PowerShell's Start-Process makes the process a child of a
 * short-lived PowerShell instead of this one; elsewhere a new session does the same.
 * Resolves once the process has started; rejects if it couldn't be.
 */
export function startDetached({
	command,
	args,
}: {
	command: string;
	args: string[];
}): Promise<void> {
	if (process.platform === "win32") {
		const argumentList = args
			.map((arg) => powershellQuote(`"${arg}"`))
			.join(",");
		// Not `detached`: a detached PowerShell gets no console and exits without
		// running the command. It exits right after Start-Process either way.
		const child = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$ErrorActionPreference = 'Stop'; Start-Process -WindowStyle Hidden -FilePath ${powershellQuote(command)} -ArgumentList ${argumentList}`,
			],
			{ stdio: "ignore", windowsHide: true },
		);
		return new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) =>
				code === 0
					? resolve()
					: reject(
							new Error(
								`Couldn't start ${command} (PowerShell exit code ${code})`,
							),
						),
			);
		});
	}
	const child = spawn(command, args, { stdio: "ignore", detached: true });
	child.unref();
	// A failed spawn emits "error"; unhandled, it would crash the caller.
	return new Promise((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", reject);
	});
}
