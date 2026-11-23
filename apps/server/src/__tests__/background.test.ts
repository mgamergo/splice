import { describe, expect, test } from "bun:test";
import { startDetached } from "../background";

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
