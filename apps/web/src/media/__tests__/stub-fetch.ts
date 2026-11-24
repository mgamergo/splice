import { type Mock, spyOn } from "bun:test";
import type { DiskMedia } from "@/media/types";

/** A recording under Footage, read over HTTP through a stubbed fetch. */
export const recording: DiskMedia = {
	kind: "disk",
	path: "day-1/a-cam.mkv",
	url: "http://splice.test/media/day-1/a-cam.mkv",
	name: "a-cam.mkv",
	type: "video/x-matroska",
	size: 1_000_000,
	lastModified: 0,
};

let fetchSpy: Mock<typeof fetch> | null = null;

/** Puts the real fetch back; pass it to afterEach. */
export function restoreFetch(): void {
	fetchSpy?.mockRestore();
	fetchSpy = null;
}

/** Rejects with `signal`'s reason once it aborts, the way fetch does. */
export function untilAborted<T>(
	signal: AbortSignal | null | undefined,
): Promise<T> {
	return new Promise<T>((_resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		signal?.addEventListener("abort", () => reject(signal.reason));
	});
}

/** Stubs fetch with `respond`, and resolves once the first request is made. */
export function stubFetch(
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
export function settleWithin<T>({
	promise,
	ms,
}: {
	promise: Promise<T>;
	ms: number;
}) {
	return Promise.race([
		promise.then(
			() => "resolved" as const,
			(error: unknown) => error,
		),
		new Promise<"pending">((resolve) =>
			setTimeout(() => resolve("pending"), ms),
		),
	]);
}
