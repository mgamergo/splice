import { expect, spyOn, test } from "bun:test";
import { createRpcClient, rpcDeadlineMs } from "../rpc-client";

// Measured on Bun 1.2.18: a fetch whose server stays quiet fails with a
// TimeoutError after about 5 minutes, and `timeout: false` waits it out.
test("turns off Bun's fetch idle timeout, so a long pause scan can finish", async () => {
	const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
	);
	try {
		const call = createRpcClient({ origin: "http://127.0.0.1:1", token: "t" });
		expect(await call({ method: "editor.roughCut" })).toEqual({ ok: true });
		expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			timeout: false,
			signal: expect.any(AbortSignal),
		});
	} finally {
		fetchSpy.mockRestore();
	}
});

test("gives scans, imports, rough cuts and renders half an hour and other calls two minutes", () => {
	for (const method of [
		"editor.importItems",
		"editor.relinkItem",
		"transcribe.start",
		"transcribe.status",
		"transcript.words",
		"editor.roughCut",
		"pauses.detect",
		"loudness.measure",
		"noiseReduction.render",
	])
		expect(rpcDeadlineMs(method)).toBe(30 * 60_000);
	for (const method of ["editor.getState", "footage.list"])
		expect(rpcDeadlineMs(method)).toBe(2 * 60_000);
});

test("hangs up on a call past its deadline and says which call stalled", async () => {
	const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(() =>
		AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
		new DOMException("The operation was aborted.", "AbortError"),
	);
	try {
		const call = createRpcClient({ origin: "http://127.0.0.1:1", token: "t" });
		await expect(call({ method: "pauses.detect" })).rejects.toThrow(
			"splice didn't answer pauses.detect within 30 minutes.",
		);
		expect(timeoutSpy).toHaveBeenCalledWith(30 * 60_000);
	} finally {
		fetchSpy.mockRestore();
		timeoutSpy.mockRestore();
	}
});
