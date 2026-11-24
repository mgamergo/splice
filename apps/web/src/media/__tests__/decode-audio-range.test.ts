import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { decodeAudioRange } from "@/media/audio";
import type { DiskMedia } from "@/media/types";

let fetchSpy: Mock<typeof fetch> | null = null;

afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
});

const recording: DiskMedia = {
	kind: "disk",
	path: "day-1/a-cam.mkv",
	url: "http://splice.test/media/day-1/a-cam.mkv",
	name: "a-cam.mkv",
	type: "video/x-matroska",
	size: 1_000_000,
	lastModified: 0,
};

/** Rejects with `signal`'s reason once it aborts, the way fetch does. */
function untilAborted<T>(signal: AbortSignal | null | undefined): Promise<T> {
	return new Promise<T>((_resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		signal?.addEventListener("abort", () => reject(signal.reason));
	});
}

/** Stubs fetch with `respond`, and resolves once the first request is made. */
function stubFetch(
	respond: (init: RequestInit | undefined) => Promise<Response>,
) {
	const signals: AbortSignal[] = [];
	let requested: () => void = () => {};
	const firstRequest = new Promise<void>((resolve) => {
		requested = resolve;
	});
	// fetch's own signature, so positional.
	const stub = (...[, init]: Parameters<typeof fetch>) => {
		if (init?.signal) signals.push(init.signal);
		requested();
		return respond(init);
	};
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(stub, { preconnect: globalThis.fetch.preconnect }),
	);
	return { signals, firstRequest };
}

/** The promise's outcome, or "pending" if it hasn't settled in time. */
function settleWithin<T>({ promise, ms }: { promise: Promise<T>; ms: number }) {
	return Promise.race([
		promise.then(
			() => "resolved" as const,
			(error: unknown) => error,
		),
		new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
	]);
}

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
