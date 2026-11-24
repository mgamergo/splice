import { expect, spyOn, test } from "bun:test";
import { createRpcClient } from "../rpc-client";

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
		});
	} finally {
		fetchSpy.mockRestore();
	}
});
