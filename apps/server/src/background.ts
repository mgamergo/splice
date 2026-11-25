import { spawn } from "node:child_process";

/** Quotes a value for a single-quoted PowerShell string. */
function powershellQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The PowerShell that starts `command` on Windows. `outsideJob` creates it
 * through WMI, whose provider host is its parent: agent hosts run MCP servers
 * in a job object and kill the whole job on restart, and a process started
 * any other way, Start-Process included, stays in its parent's job. Where WMI
 * is unavailable it falls back to Start-Process.
 */
export function windowsLaunchScript({
	command,
	args,
	hidden,
	outsideJob,
	cwd = process.cwd(),
}: {
	command: string;
	args: string[];
	hidden: boolean;
	outsideJob: boolean;
	/** WMI would otherwise start the process in System32. */
	cwd?: string;
}): string {
	const startProcess = `Start-Process${hidden ? " -WindowStyle Hidden" : ""} -FilePath ${powershellQuote(command)}${
		args.length
			? ` -ArgumentList ${args.map((arg) => powershellQuote(`"${arg}"`)).join(",")}`
			: ""
	}`;
	if (!outsideJob) return `$ErrorActionPreference = 'Stop'; ${startProcess}`;
	const commandLine = [command, ...args]
		.map((part) => `"${part.replaceAll('"', '\\"')}"`)
		.join(" ");
	return [
		"$ErrorActionPreference = 'Stop'",
		"try {",
		`  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]${hidden ? 0 : 1} }`,
		`  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powershellQuote(commandLine)}; CurrentDirectory = ${powershellQuote(cwd)}; ProcessStartupInformation = $startup }`,
		"  if ($created.ReturnValue -ne 0) { throw \"Win32_Process.Create returned $($created.ReturnValue)\" }",
		"} catch {",
		`  ${startProcess}`,
		"}",
	].join("; ").replaceAll("{; ", "{ ").replaceAll("; }", " }");
}

/**
 * Starts a process that outlives the one starting it. Agent hosts restart MCP
 * servers by killing their whole process tree, which would take a plain child
 * with it. On Windows, PowerShell starts it (see `windowsLaunchScript`);
 * elsewhere a new session does the same. `hidden: false` shows its window,
 * for a file manager. Resolves once the process has started; rejects if it
 * couldn't be.
 */
export function startDetached({
	command,
	args,
	hidden = true,
	outsideJob = false,
}: {
	command: string;
	args: string[];
	hidden?: boolean;
	/** Windows: leave the job object the agent host runs this process in. */
	outsideJob?: boolean;
}): Promise<void> {
	if (process.platform === "win32") {
		// Not `detached`: a detached PowerShell gets no console and exits without
		// running the command. It exits right after starting it either way.
		const child = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				windowsLaunchScript({ command, args, hidden, outsideJob }),
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
