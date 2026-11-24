import { afterEach, describe, expect, mock, test } from "bun:test";
import { decodeAudioRange } from "@/media/audio";
import { createMediaSource, ignoreAbortedRead } from "@/media/media-data";
import {
	recording,
	restoreFetch,
	settleWithin,
	stubFetch,
	untilAborted,
} from "./stub-fetch";

afterEach(restoreFetch);

/** Hands `reason` to the page listener as an unhandled rejection; true if it was dropped. */
function isIgnored(reason: unknown): boolean {
	const preventDefault = mock(() => {});
	ignoreAbortedRead({ reason, preventDefault });
	return preventDefault.mock.calls.length > 0;
}

describe("ignoreAbortedRead", () => {
	test("drops a rejection with the reason of an aborted media signal, which waiting reads still get", async () => {
		const { firstRequest } = stubFetch((init) => untilAborted(init?.signal));
		const controller = new AbortController();
		const decode = decodeAudioRange({
			file: recording,
			range: { start: 10, end: 20 },
			sampleRate: 48000,
			signal: controller.signal,
		});
		await firstRequest;
		controller.abort();

		const reason: unknown = await settleWithin({ promise: decode, ms: 1000 });
		expect(reason).toBe(controller.signal.reason);
		expect(isIgnored(reason)).toBe(true);
	});

	test("drops the reason of a signal that was already aborted", () => {
		const controller = new AbortController();
		controller.abort();
		createMediaSource({ data: recording, signal: controller.signal });

		expect(isIgnored(controller.signal.reason)).toBe(true);
	});

	test("keeps every other rejection", () => {
		const unused = new AbortController();
		unused.abort();
		const pending = new AbortController();
		createMediaSource({ data: recording, signal: pending.signal });

		expect(isIgnored(new Error("boom"))).toBe(false);
		expect(isIgnored(new DOMException("other", "AbortError"))).toBe(false);
		expect(isIgnored(unused.signal.reason)).toBe(false);
		expect(isIgnored("AbortError")).toBe(false);
		expect(isIgnored(undefined)).toBe(false);
	});
});
