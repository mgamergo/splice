import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startDetached, windowsLaunchScript } from "../background";
import { applyLaunchEnv, writeLaunchEnv } from "../launch-env";

describe("startDetached", () => {
	test("reports a command that can't be started instead of crashing", async () => {
		await expect(
			startDetached({ command: "/nonexistent/splice-test-binary", args: [] }),
		).rejects.toThrow();
	});

	test("resolves once the process has started", async () => {
		await expect(
			startDetached({ command: process.execPath, args: ["-e", "0"] }),
		).resolves.toBeUndefined();
	});
});

describe("windowsLaunchScript", () => {
	const bun = "C:\\Users\\Me\\.bun\\bin\\bun.exe";
	const cli = "D:\\Splice app\\apps\\server\\src\\cli.ts";

	test("starts splice through WMI, outside the agent host's job, falling back to Start-Process", () => {
		const script = windowsLaunchScript({
			command: bun,
			args: [cli, "serve"],
			hidden: true,
			outsideJob: true,
			cwd: "D:\\Splice app",
		});
		expect(script).toContain(
			`CommandLine = '"${bun}" "${cli}" "serve"'; CurrentDirectory = 'D:\\Splice app'`,
		);
		expect(script).toContain("ShowWindow = [uint16]0");
		expect(script).toContain(
			`catch {   Start-Process -WindowStyle Hidden -FilePath '${bun}' -ArgumentList '"${cli}"','"serve"'`,
		);
	});

	test("shows the file manager it opens", () => {
		expect(
			windowsLaunchScript({
				command: "explorer.exe",
				args: ["D:\\Splice\\Exports"],
				hidden: false,
				outsideJob: false,
			}),
		).toBe(
			"$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'explorer.exe' -ArgumentList '\"D:\\Splice\\Exports\"'",
		);
	});
});

describe("--launch-env", () => {
	test("splice applies the environment splice mcp wrote, deletes the file and drops the option", async () => {
		const previous = process.env.SPLICE_LAUNCH_TEST;
		process.env.SPLICE_LAUNCH_TEST = "from-mcp";
		const file = await writeLaunchEnv();
		delete process.env.SPLICE_LAUNCH_TEST;
		try {
			const env: Record<string, string | undefined> = {};
			expect(
				await applyLaunchEnv({ argv: ["serve", "--launch-env", file, "--dev"], env }),
			).toEqual([
				"serve",
				"--dev",
			]);
			expect(env.SPLICE_LAUNCH_TEST).toBe("from-mcp");
			expect(existsSync(file)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.SPLICE_LAUNCH_TEST;
			else process.env.SPLICE_LAUNCH_TEST = previous;
		}
	});
});
