import { afterEach, describe, expect, test } from "bun:test";
import { VideoCache } from "@/services/video-cache/service";
import {
	recording,
	restoreFetch,
	settleWithin,
	stubFetch,
	untilAborted,
} from "@/media/__tests__/stub-fetch";

afterEach(restoreFetch);

describe("VideoCache cancellation", () => {
	test("its signal stops a frame read whose response never arrives", async () => {
		const { signals, firstRequest } = stubFetch((init) =>
			untilAborted(init?.signal),
		);
		const controller = new AbortController();
		const cache = new VideoCache({ signal: controller.signal });
		const frame = cache.getFrameAt({
			mediaId: "a-cam",
			file: recording,
			time: 62.5,
		});
		await firstRequest;
		controller.abort();

		// Without the signal the read, and the export waiting on it, never ends.
		expect(await settleWithin({ promise: frame, ms: 1000 })).toMatchObject({
			name: "AbortError",
		});
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		cache.clearAll();
	});
});
