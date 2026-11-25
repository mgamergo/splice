import { afterEach, expect, test } from "bun:test";
import { denoisedAudioUrlForPath } from "@splice/bridge";
import { videoClip } from "@/agent/__tests__/fixtures";
import type { EditorCore } from "@/core";
import { AudioManager } from "@/core/managers/audio-manager";
import {
	recording,
	restoreFetch,
	stubFetch,
} from "@/media/__tests__/stub-fetch";
import { type AudioClipSource, collectAudioClipSources } from "@/media/audio";
import type { ProjectItem } from "@/media/types";
import type { SequenceTracks } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";

afterEach(restoreFetch);

/** An AudioManager whose editor only takes the subscriptions it makes. */
function createManager(): AudioManager {
	const subscribe = () => () => {};
	const editor = {
		playback: { getVolume: () => 1, subscribe, onSeek: subscribe },
		timeline: { subscribe },
		media: { subscribe },
		sequences: { subscribe },
	};
	return new AudioManager(editor as unknown as EditorCore);
}

const item: ProjectItem = {
	id: "rec",
	name: "rec",
	type: "video",
	duration: 60,
	hasAudio: true,
	file: recording,
};

/** Clips that all play seconds 10 to 12 of the recording, one after another. */
async function sourcesOfOneSpan(
	clips: Array<{ id: string; noiseReduction: boolean }>,
): Promise<AudioClipSource[]> {
	const { tracks: defaults } = buildDefaultSequence({
		name: "Main sequence",
		isMain: true,
	});
	const tracks: SequenceTracks = {
		...defaults,
		main: {
			...defaults.main,
			clips: clips.map(({ id, noiseReduction }, index) => ({
				...videoClip({ id, start: index * 2, duration: 2, trimStart: 10 }),
				params: { noiseReduction },
			})),
		},
	};
	const sources = await collectAudioClipSources({
		tracks,
		projectItems: [item],
	});
	return clips.map(({ id }) => {
		const source = sources.find((candidate) => candidate.id === id);
		if (!source) throw new Error(`No audio source for ${id}`);
		return source;
	});
}

test("a plain and a denoised clip of one recording never share a range decode", async () => {
	// The reads never answer, so every decode stays in flight.
	const { urls, firstRequest } = stubFetch(() => new Promise<Response>(() => {}));
	const [plain, denoised, denoisedAgain] = await sourcesOfOneSpan([
		{ id: "plain", noiseReduction: false },
		{ id: "denoised", noiseReduction: true },
		{ id: "denoised-again", noiseReduction: true },
	]);
	expect(plain.sourceKey).toBe("rec");
	expect(denoised.sourceKey).toBe("rec:denoised");

	const manager = createManager();
	// The private decode is what playback shares between clips.
	const decode = (clip: AudioClipSource) =>
		manager["decodeClipRange"]({
			clip,
			range: { start: 9.9, end: 12.1 },
			sampleRate: 48000,
		});
	try {
		const plainDecode = decode(plain);
		const denoisedDecode = decode(denoised);
		// Two denoised clips of one span share their decode...
		expect(decode(denoisedAgain)).toBe(denoisedDecode);
		// ...but the plain clip of that span decodes on its own.
		expect(denoisedDecode).not.toBe(plainDecode);
		expect(manager["pendingRangeDecodes"].size).toBe(2);

		// And each reads its own file: the recording, and splice's WAV render.
		await firstRequest;
		await new Promise((resolve) => setTimeout(resolve, 20));
		const denoisedUrl = denoisedAudioUrlForPath(recording.path);
		expect(urls).toContain(recording.url);
		expect(urls.some((url) => url.endsWith(denoisedUrl))).toBe(true);
		expect(
			urls.every((url) => url === recording.url || url.endsWith(denoisedUrl)),
		).toBe(true);
	} finally {
		manager.dispose();
	}
});
