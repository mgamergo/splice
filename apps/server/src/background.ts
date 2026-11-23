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
 */
export function startDetached({
	command,
	args,
}: {
	command: string;
	args: string[];
}): Promise<void> {
	const child =
		process.platform === "win32"
			? spawn(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`Start-Process -WindowStyle Hidden -FilePath ${powershellQuote(command)} -ArgumentList ${args
							.map((arg) => powershellQuote(`"${arg}"`))
							.join(",")}`,
					],
					{ stdio: "ignore", windowsHide: true, detached: true },
				)
			: spawn(command, args, { stdio: "ignore", detached: true });
	child.unref();
	// A failed spawn emits "error"; unhandled, it would crash the caller.
	return new Promise((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", reject);
	});
}
