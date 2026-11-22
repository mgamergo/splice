import { describe, expect, test } from "bun:test";
import type { Transform } from "@/rendering";
import type { SequenceTracks, VideoClip } from "@/timeline";
import { applyClipUpdate } from "@/timeline/update-pipeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildTransform(): Transform {
	return {
		scaleX: 1,
		scaleY: 1,
		position: { x: 0, y: 0 },
		rotate: 0,
	};
}

function buildVideoClip(overrides: Partial<VideoClip> = {}): VideoClip {
	return {
		id: "video-1",
		type: "video",
		name: "Video 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
		...overrides,
	};
}

function buildTracks(clip: VideoClip): SequenceTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			clips: [clip],
		},
		audio: [],
	};
}

describe("applyClipUpdate", () => {
	test("rounds retimed durations back to integer media time", () => {
		const clip = buildVideoClip();
		const tracks = buildTracks(clip);

		const updatedClip = applyClipUpdate({
			clip,
			patch: {
				retime: { rate: 1.5 },
			},
			context: {
				tracks,
				trackId: tracks.main.id,
			},
		});

		expect(updatedClip.duration).toBe(mediaTime({ ticks: 7 }));
		expect(Number.isInteger(updatedClip.duration)).toBe(true);
	});
});
