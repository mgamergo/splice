import { afterEach, describe, expect, test } from "bun:test";
import { decodeAudioRange } from "@/media/audio";
import {
	recording,
	restoreFetch,
	settleWithin,
	stubFetch,
	untilAborted,
} from "./stub-fetch";

afterEach(restoreFetch);


describe("decodeAudioRange cancellation", () => {
	test("stops a read whose response headers never arrive", async () => {
		const { signals, firstRequest } = stubFetch((init) =>
			untilAborted(init?.signal),
		);
		const controller = new AbortController();
		const decode = decodeAudioRange({
			file: recording,
			range: { start: 10, end: 20 },
			sampleRate: 48000,
			signal: controller.signal,
		});
		await firstRequest;
		controller.abort();

		expect(await settleWithin({ promise: decode, ms: 1000 })).toMatchObject({
			name: "AbortError",
		});
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});

	test("stops a read whose body stalls after the headers", async () => {
		const { signals, firstRequest } = stubFetch(async (init) => {
			const signal = init?.signal;
			// The headers come back, then the bytes never do.
			const body = new ReadableStream<Uint8Array>({
				start(stream) {
					signal?.addEventListener("abort", () => stream.error(signal.reason));
				},
			});
			return new Response(body, {
				status: 206,
				headers: {
					"Content-Range": `bytes 0-${recording.size - 1}/${recording.size}`,
					"Content-Length": String(recording.size),
				},
			});
		});
		const controller = new AbortController();
		const decode = decodeAudioRange({
			file: recording,
			range: { start: 10, end: 20 },
			sampleRate: 48000,
			signal: controller.signal,
		});
		await firstRequest;
		// Let the response arrive and its body start being read.
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();

		expect(await settleWithin({ promise: decode, ms: 1000 })).toMatchObject({
			name: "AbortError",
		});
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});
});
