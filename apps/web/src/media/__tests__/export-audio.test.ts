import { afterEach, expect, type Mock, spyOn, test } from "bun:test";
import { denoisedAudioUrlForPath } from "@splice/bridge";
import { audioClip, s, videoClip } from "@/agent/__tests__/fixtures";
import type { ProjectItem } from "@/media/types";
import {
	createTimelineAudioBuffer,
	createTimelineAudioReader,
} from "@/media/audio";
import type { LibraryAudioClip, SequenceTracks } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";
import { recording, restoreFetch, stubFetch, untilAborted } from "./stub-fetch";

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
					...videoClip({
						id: "denoised",
						start: 0,
						duration: 2,
						trimStart: 10,
					}),
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
	const { urls, firstRequest } = stubFetch((init) =>
		untilAborted(init?.signal),
	);

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

test("a late seek and sequential export render the same samples with one-second PCM allocations", async () => {
	const makeBuffer: BaseAudioContext["createBuffer"] = (
		...[count, length, sampleRate]
	) => {
		const channels = Array.from(
			{ length: count },
			() => new Float32Array(length),
		);
		return {
			duration: length / sampleRate,
			length,
			numberOfChannels: count,
			sampleRate,
			getChannelData: (index) => channels[index],
			copyFromChannel: (...[destination, channel, start = 0]) => {
				destination.set(
					channels[channel].subarray(start, start + destination.length),
				);
			},
			copyToChannel: (...[source, channel, start = 0]) => {
				channels[channel].set(source, start);
			},
		};
	};
	const rate = 44100;
	const buffer = makeBuffer(1, rate, rate);
	const data = buffer.getChannelData(0);
	for (let index = 0; index < data.length; index++)
		data[index] = 0.8 * Math.sin((index * 2 * Math.PI * 997) / rate);
	const { tracks } = buildDefaultSequence({
		name: "Main sequence",
		isMain: true,
	});
	tracks.audio.push({
		id: "audio",
		name: "Audio",
		type: "audio",
		muted: false,
		clips: [{ ...librarySound({ id: "near-end", start: 3598 }), buffer }],
	});
	const allocations: number[] = [];
	const reader = createTimelineAudioReader({
		tracks,
		projectItems: [],
		duration: s(3600),
		audioContext: {
			sampleRate: rate,
			createBuffer: (...args: Parameters<typeof makeBuffer>) => {
				allocations.push(args[1]);
				return makeBuffer(...args);
			},
		} as BaseAudioContext,
	});
	if (!reader) throw new Error("Expected an audio reader");
	const master = { gainDb: 6, ceilingDbtp: -1 };
	const exportBlocks = reader.blocks({ master, fromSeconds: 3597 });
	await exportBlocks.next();
	const full = await exportBlocks.next();
	const seekBlocks = reader.blocks({ master, fromSeconds: 3598.25 });
	const seek = await seekBlocks.next();
	if (full.done || seek.done) throw new Error("Expected rendered blocks");
	expect(seek.value.time).toBe(3598.25);
	const samples = seek.value.buffer.getChannelData(0);
	expect(samples.some((sample) => sample !== 0)).toBe(true);
	expect(samples).toEqual(
		full.value.buffer.getChannelData(0).subarray(rate / 4),
	);
	expect(allocations.length).toBeLessThanOrEqual(8);
	expect(Math.max(...allocations)).toBeLessThanOrEqual(rate);
	await seekBlocks.return();
	await exportBlocks.return();
});
