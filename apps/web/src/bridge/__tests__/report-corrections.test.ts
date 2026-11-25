import { expect, spyOn, test } from "bun:test";
import type { Correction } from "@splice/bridge/profile";
import { flushCorrections, reportCorrections } from "../report-corrections";
import * as spliceApi from "../splice-api";

test("a reconnect during a failed capture retries the same Correction", async () => {
	const before = {
		projectItemId: "item",
		recording: "talk.wav",
		sourceIn: 1,
		sourceOut: 4,
	};
	const correction: Correction = {
		id: crypto.randomUUID(),
		kind: "retrim",
		projectId: "project",
		sequenceId: "sequence",
		revision: 2,
		timestamp: "2026-11-25T12:00:00.000Z",
		before: [before],
		after: [{ ...before, sourceOut: 4.2 }],
		decision: {
			kind: "pause",
			edge: "out",
			sourceIn: 4,
			sourceOut: 6,
			removedSeconds: 2,
		},
	};
	const first = Promise.withResolvers<unknown>();
	const retried = Promise.withResolvers<void>();
	const call = spyOn(spliceApi, "callSplice")
		.mockImplementationOnce(() => first.promise)
		.mockImplementationOnce(async () => {
			retried.resolve();
		});
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		reportCorrections([correction]);
		await flushCorrections();
		first.reject(new Error("Splice stopped"));
		await retried.promise;
		expect(call.mock.calls).toEqual([
			[{ method: "profile.capture", params: { corrections: [correction] } }],
			[{ method: "profile.capture", params: { corrections: [correction] } }],
		]);
	} finally {
		call.mockRestore();
		warn.mockRestore();
	}
});
