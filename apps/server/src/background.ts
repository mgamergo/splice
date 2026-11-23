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
}): void {
	if (process.platform === "win32") {
		const argumentList = args
			.map((arg) => powershellQuote(`"${arg}"`))
			.join(",");
		const child = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Start-Process -WindowStyle Hidden -FilePath ${powershellQuote(command)} -ArgumentList ${argumentList}`,
			],
			{ stdio: "ignore", windowsHide: true, detached: true },
		);
		child.unref();
		return;
	}
	const child = spawn(command, args, { stdio: "ignore", detached: true });
	child.unref();
}
