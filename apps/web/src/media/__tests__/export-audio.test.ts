import { afterEach, expect, type Mock, spyOn, test } from "bun:test";
import { audioClip, s } from "@/agent/__tests__/fixtures";
import { createTimelineAudioBuffer } from "@/media/audio";
import type { LibraryAudioClip, SequenceTracks } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";

let fetchSpy: Mock<typeof fetch> | null = null;

afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
});

function librarySound({
	id,
	start,
}: {
	id: string;
	start: number;
}): LibraryAudioClip {
	return {
		...audioClip({ id, start, duration: 1 }),
		sourceType: "library",
		sourceUrl: `https://sounds.test/${id}.mp3`,
	};
}

test("a cancelled export stops mixing audio instead of decoding the clips left", async () => {
	const { tracks: defaults } = buildDefaultSequence({
		name: "Main sequence",
		isMain: true,
	});
	const tracks: SequenceTracks = {
		...defaults,
		audio: [
			{
				id: "a1",
				name: "A1",
				type: "audio",
				muted: false,
				clips: [
					librarySound({ id: "first", start: 0 }),
					librarySound({ id: "second", start: 1 }),
				],
			},
		],
	};

	// Each fetch waits until the export's signal aborts it.
	let fetchStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		fetchStarted = resolve;
	});
	// fetch's own signature, so positional.
	const pendingFetch = (...[, init]: Parameters<typeof fetch>) => {
		fetchStarted();
		const signal = init?.signal;
		return new Promise<Response>((_resolve, reject) => {
			if (signal?.aborted) return reject(signal.reason);
			signal?.addEventListener("abort", () => reject(signal.reason));
		});
	};
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(pendingFetch, { preconnect: globalThis.fetch.preconnect }),
	);

	const controller = new AbortController();
	const mix = createTimelineAudioBuffer({
		tracks,
		projectItems: [],
		duration: s(2),
		// Never reached: the mix stops before it allocates the output.
		audioContext: { sampleRate: 44100 } as AudioContext,
		signal: controller.signal,
	});
	await started;
	controller.abort();

	await expect(mix).rejects.toMatchObject({ name: "AbortError" });
	expect(fetchSpy?.mock.calls).toHaveLength(1);
});
