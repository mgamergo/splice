import { afterEach, expect, type Mock, spyOn, test } from "bun:test";
import { denoisedAudioUrlForPath } from "@splice/bridge";
import { audioClip, s, videoClip } from "@/agent/__tests__/fixtures";
import type { ProjectItem } from "@/media/types";
import {
	recording,
	restoreFetch,
	stubFetch,
	untilAborted,
} from "./stub-fetch";
import { createTimelineAudioBuffer } from "@/media/audio";
import type { LibraryAudioClip, SequenceTracks } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";

let fetchSpy: Mock<typeof fetch> | null = null;

afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
	restoreFetch();
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

test("the export decodes a noise-reduced clip's range from splice's WAV render", async () => {
	const { tracks: defaults } = buildDefaultSequence({
		name: "Main sequence",
		isMain: true,
	});
	const tracks: SequenceTracks = {
		...defaults,
		main: {
			...defaults.main,
			clips: [
				{
					...videoClip({ id: "denoised", start: 0, duration: 2, trimStart: 10 }),
					params: { noiseReduction: true },
				},
			],
		},
	};
	const item: ProjectItem = {
		id: "rec",
		name: "rec",
		type: "video",
		duration: 60,
		hasAudio: true,
		file: recording,
	};
	const { urls, firstRequest } = stubFetch((init) => untilAborted(init?.signal));

	const controller = new AbortController();
	const mix = createTimelineAudioBuffer({
		tracks,
		projectItems: [item],
		duration: s(2),
		audioContext: { sampleRate: 44100 } as AudioContext,
		signal: controller.signal,
	});
	await firstRequest;
	controller.abort();

	await expect(mix).rejects.toMatchObject({ name: "AbortError" });
	const denoisedUrl = denoisedAudioUrlForPath(recording.path);
	expect(urls.length).toBeGreaterThan(0);
	expect(urls.every((url) => url.endsWith(denoisedUrl))).toBe(true);
});
