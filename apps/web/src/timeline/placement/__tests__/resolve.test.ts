import { describe, expect, test } from "bun:test";
import type {
	AudioClip,
	AudioTrack,
	GraphicClip,
	GraphicTrack,
	OverlayTrack,
	SequenceTracks,
	TextClip,
	TextTrack,
	TimelineTrack,
	VideoClip,
	VideoTrack,
} from "@/timeline";
import type { Transform } from "@/rendering";
import { resolveTrackPlacement } from "@/timeline/placement";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildTransform(): Transform {
	return {
		scaleX: 1,
		scaleY: 1,
		position: { x: 0, y: 0 },
		rotate: 0,
	};
}

type TestClip = AudioClip | GraphicClip | TextClip | VideoClip;

function buildClip(params: {
	id: string;
	type: "audio";
	startTime: number;
	duration: number;
}): AudioClip;
function buildClip(params: {
	id: string;
	type: "graphic";
	startTime: number;
	duration: number;
}): GraphicClip;
function buildClip(params: {
	id: string;
	type: "text";
	startTime: number;
	duration: number;
}): TextClip;
function buildClip(params: {
	id: string;
	type: "video";
	startTime: number;
	duration: number;
}): VideoClip;
function buildClip({
	id,
	type,
	startTime,
	duration,
}: {
	id: string;
	type: TestClip["type"];
	startTime: number;
	duration: number;
}): TestClip {
	switch (type) {
		case "audio":
			return {
				id,
				type: "audio",
				name: id,
				startTime: mediaTime({ ticks: startTime }),
				duration: mediaTime({ ticks: duration }),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				params: { volume: 1, muted: false },
				sourceType: "upload",
				mediaId: `media-${id}`,
			} satisfies AudioClip;
		case "graphic":
			return {
				id,
				type: "graphic",
				name: id,
				startTime: mediaTime({ ticks: startTime }),
				duration: mediaTime({ ticks: duration }),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				definitionId: `graphic-${id}`,
				params: {
					"transform.positionX": 0,
					"transform.positionY": 0,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
					"transform.rotate": 0,
					opacity: 1,
				},
			} satisfies GraphicClip;
		case "text":
			return {
				id,
				type: "text",
				name: id,
				startTime: mediaTime({ ticks: startTime }),
				duration: mediaTime({ ticks: duration }),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				params: {
					content: id,
					fontSize: 32,
					fontFamily: "sans-serif",
					color: "#ffffff",
					"background.enabled": false,
					"background.color": "#000000",
					textAlign: "left",
					fontWeight: "normal",
					fontStyle: "normal",
					textDecoration: "none",
					"transform.positionX": 0,
					"transform.positionY": 0,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
					"transform.rotate": 0,
					opacity: 1,
				},
			} satisfies TextClip;
		case "video":
			return {
				id,
				type: "video",
				name: id,
				startTime: mediaTime({ ticks: startTime }),
				duration: mediaTime({ ticks: duration }),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				mediaId: `media-${id}`,
				params: {
					"transform.positionX": 0,
					"transform.positionY": 0,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
					"transform.rotate": 0,
					opacity: 1,
				},
			} satisfies VideoClip;
	}

	throw new Error(`Unsupported test clip type: ${type}`);
}

type BuildTrackParams =
	| {
			id: string;
			type: "audio";
			clips?: AudioTrack["clips"];
	  }
	| {
			id: string;
			type: "graphic";
			clips?: GraphicTrack["clips"];
	  }
	| {
			id: string;
			type: "text";
			clips?: TextTrack["clips"];
	  }
	| {
			id: string;
			type: "video";
			clips?: VideoTrack["clips"];
	  };

function buildTrack(params: {
	id: string;
	type: "audio";
	clips?: AudioTrack["clips"];
}): AudioTrack;
function buildTrack(params: {
	id: string;
	type: "graphic";
	clips?: GraphicTrack["clips"];
}): GraphicTrack;
function buildTrack(params: {
	id: string;
	type: "text";
	clips?: TextTrack["clips"];
}): TextTrack;
function buildTrack(params: {
	id: string;
	type: "video";
	clips?: VideoTrack["clips"];
}): VideoTrack;
function buildTrack(params: BuildTrackParams): TimelineTrack {
	const { id, type } = params;

	switch (type) {
		case "audio":
			return {
				id,
				type: "audio",
				name: id,
				clips: params.clips ?? [],
				muted: false,
			};
		case "graphic":
			return {
				id,
				type: "graphic",
				name: id,
				clips: params.clips ?? [],
				hidden: false,
			};
		case "text":
			return {
				id,
				type: "text",
				name: id,
				clips: params.clips ?? [],
				hidden: false,
			};
		case "video":
			return {
				id,
				type: "video",
				name: id,
				clips: params.clips ?? [],
				muted: false,
				hidden: false,
			};
	}

	throw new Error(`Unsupported test track type: ${type}`);
}

function buildTimeSpan({
	startTime,
	duration,
	excludeClipId,
}: {
	startTime: number;
	duration: number;
	excludeClipId?: string;
}) {
	return {
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		excludeClipId,
	};
}

function buildSequenceTracks({
	overlay = [],
	main,
	audio = [],
}: {
	overlay?: Array<OverlayTrack>;
	main?: VideoTrack;
	audio?: Array<AudioTrack>;
}): SequenceTracks {
	return {
		overlay,
		main:
			main ??
			buildTrack({
				id: "video-main",
				type: "video",
			}),
		audio,
	};
}

describe("resolveTrackPlacement", () => {
	test("explicit returns the requested compatible track", () => {
		const tracks = buildSequenceTracks({
			overlay: [buildTrack({ id: "text-1", type: "text" })],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "text",
				timeSpans: [buildTimeSpan({ startTime: 2, duration: 3 })],
				strategy: { type: "explicit", trackId: "text-1" },
			}),
		).toEqual({
			kind: "existingTrack",
			trackId: "text-1",
			trackIndex: 0,
			trackType: "text",
		});
	});

	test("explicit rejects missing and incompatible tracks", () => {
		const tracks = buildSequenceTracks({
			main: buildTrack({ id: "video-1", type: "video" }),
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "text",
				timeSpans: [buildTimeSpan({ startTime: 0, duration: 1 })],
				strategy: { type: "explicit", trackId: "missing" },
			}),
		).toBeNull();

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "text",
				timeSpans: [buildTimeSpan({ startTime: 0, duration: 1 })],
				strategy: { type: "explicit", trackId: "video-1" },
			}),
		).toBeNull();
	});

	test("firstAvailable picks the first compatible track without overlap", () => {
		const tracks = buildSequenceTracks({
			overlay: [
				buildTrack({
					id: "text-1",
					type: "text",
					clips: [
						buildClip({ id: "a", type: "text", startTime: 0, duration: 5 }),
					],
				}),
				buildTrack({ id: "text-2", type: "text" }),
			],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "text",
				timeSpans: [buildTimeSpan({ startTime: 2, duration: 1 })],
				strategy: { type: "firstAvailable" },
			}),
		).toEqual({
			kind: "existingTrack",
			trackId: "text-2",
			trackIndex: 1,
			trackType: "text",
		});
	});

	test("firstAvailable creates a new track when all compatible tracks are full", () => {
		const tracks = buildSequenceTracks({
			overlay: [
				buildTrack({
					id: "graphic-1",
					type: "graphic",
					clips: [
						buildClip({
							id: "a",
							type: "graphic",
							startTime: 0,
							duration: 5,
						}),
					],
				}),
			],
			main: buildTrack({
				id: "video-main",
				type: "video",
			}),
			audio: [buildTrack({ id: "audio-1", type: "audio" })],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "graphic",
				timeSpans: [buildTimeSpan({ startTime: 1, duration: 1 })],
				strategy: { type: "firstAvailable" },
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "graphic",
			insertIndex: 0,
			insertPosition: null,
		});
	});

	test("preferIndex uses the preferred track when it fits", () => {
		const tracks = buildSequenceTracks({
			audio: [buildTrack({ id: "audio-1", type: "audio" })],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "audio",
				timeSpans: [buildTimeSpan({ startTime: 3, duration: 2 })],
				strategy: {
					type: "preferIndex",
					trackIndex: 0,
					hoverDirection: "below",
				},
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "audio",
			insertIndex: 1,
			insertPosition: "below",
		});
	});

	test("preferIndex creates a new overlay track above the main track", () => {
		const tracks = buildSequenceTracks({
			main: buildTrack({ id: "video-main", type: "video" }),
			audio: [buildTrack({ id: "audio-1", type: "audio" })],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "graphic",
				timeSpans: [buildTimeSpan({ startTime: 1, duration: 2 })],
				strategy: {
					type: "preferIndex",
					trackIndex: 1,
					hoverDirection: "below",
				},
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "graphic",
			insertIndex: 0,
			insertPosition: "above",
		});
	});

	test("preferIndex keeps audio tracks below the main track", () => {
		const tracks = buildSequenceTracks({
			overlay: [buildTrack({ id: "text-1", type: "text" })],
			main: buildTrack({ id: "video-main", type: "video" }),
			audio: [buildTrack({ id: "audio-1", type: "audio" })],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "audio",
				timeSpans: [buildTimeSpan({ startTime: 0, duration: 1 })],
				strategy: {
					type: "preferIndex",
					trackIndex: 0,
					hoverDirection: "above",
					createNewTrackOnly: true,
				},
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "audio",
			insertIndex: 2,
			insertPosition: "below",
		});
	});

	test("aboveSource tries the track above source, then any compatible track", () => {
		const tracks = buildSequenceTracks({
			overlay: [
				buildTrack({ id: "text-top", type: "text" }),
				buildTrack({
					id: "text-middle",
					type: "text",
					clips: [
						buildClip({ id: "a", type: "text", startTime: 0, duration: 5 }),
					],
				}),
				buildTrack({ id: "text-source", type: "text" }),
			],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "text",
				timeSpans: [buildTimeSpan({ startTime: 1, duration: 1 })],
				strategy: { type: "aboveSource", sourceTrackIndex: 2 },
			}),
		).toEqual({
			kind: "existingTrack",
			trackId: "text-top",
			trackIndex: 0,
			trackType: "text",
		});
	});

	test("aboveSource creates a new overlay track in the overlay zone when none fit", () => {
		const tracks = buildSequenceTracks({
			overlay: [
				buildTrack({
					id: "text-top",
					type: "text",
					clips: [
						buildClip({ id: "a", type: "text", startTime: 0, duration: 5 }),
					],
				}),
				buildTrack({
					id: "text-source",
					type: "text",
					clips: [
						buildClip({ id: "b", type: "text", startTime: 0, duration: 5 }),
					],
				}),
			],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "text",
				timeSpans: [buildTimeSpan({ startTime: 1, duration: 1 })],
				strategy: { type: "aboveSource", sourceTrackIndex: 1 },
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "text",
			insertIndex: 0,
			insertPosition: null,
		});
	});

	test("alwaysNew honors highest and default insertion rules", () => {
		const tracks = buildSequenceTracks({
			main: buildTrack({ id: "video-main", type: "video" }),
			audio: [buildTrack({ id: "audio-1", type: "audio" })],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "audio",
				timeSpans: [],
				strategy: { type: "alwaysNew", position: "highest" },
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "audio",
			insertIndex: 1,
			insertPosition: null,
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "audio",
				timeSpans: [],
				strategy: { type: "alwaysNew", position: "default" },
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "audio",
			insertIndex: 2,
			insertPosition: null,
		});
	});

	test("batch time spans reject tracks when any span overlaps", () => {
		const tracks = buildSequenceTracks({
			audio: [
				buildTrack({
					id: "audio-1",
					type: "audio",
					clips: [
						buildClip({ id: "a", type: "audio", startTime: 0, duration: 2 }),
						buildClip({ id: "b", type: "audio", startTime: 5, duration: 2 }),
					],
				}),
			],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "audio",
				timeSpans: [
					buildTimeSpan({ startTime: 3, duration: 1 }),
					buildTimeSpan({ startTime: 6, duration: 1 }),
				],
				strategy: { type: "firstAvailable" },
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "audio",
			insertIndex: 1,
			insertPosition: null,
		});
	});

	test("handles main-only timelines, single tracks, and track-type derivation", () => {
		expect(
			resolveTrackPlacement({
				tracks: buildSequenceTracks({}),
				clipType: "video",
				timeSpans: [buildTimeSpan({ startTime: 0, duration: 3 })],
				strategy: {
					type: "preferIndex",
					trackIndex: 0,
					hoverDirection: "below",
					createNewTrackOnly: true,
				},
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "video",
			insertIndex: 0,
			insertPosition: "above",
		});

		expect(
			resolveTrackPlacement({
				tracks: buildSequenceTracks({
					audio: [buildTrack({ id: "audio-1", type: "audio" })],
				}),
				clipType: "audio",
				timeSpans: [],
				strategy: { type: "alwaysNew", position: "default" },
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "audio",
			insertIndex: 2,
			insertPosition: null,
		});
	});

	test("existingTrack on main video includes adjustedStartTime when start snaps", () => {
		const tracks = buildSequenceTracks({
			main: buildTrack({
				id: "video-main",
				type: "video",
				clips: [
					buildClip({ id: "a", type: "video", startTime: 5, duration: 5 }),
				],
			}),
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "video",
				timeSpans: [buildTimeSpan({ startTime: 2, duration: 2 })],
				strategy: { type: "explicit", trackId: "video-main" },
			}),
		).toEqual({
			kind: "existingTrack",
			trackId: "video-main",
			trackIndex: 0,
			trackType: "video",
			adjustedStartTime: ZERO_MEDIA_TIME,
		});
	});

	test("preferIndex uses vertical drag direction when hovered track is incompatible", () => {
		const tracks = buildSequenceTracks({
			overlay: [buildTrack({ id: "text-1", type: "text" })],
			main: buildTrack({ id: "video-main", type: "video" }),
			audio: [buildTrack({ id: "audio-1", type: "audio" })],
		});

		expect(
			resolveTrackPlacement({
				tracks,
				clipType: "audio",
				timeSpans: [buildTimeSpan({ startTime: 0, duration: 1 })],
				strategy: {
					type: "preferIndex",
					trackIndex: 0,
					hoverDirection: "above",
					verticalDragDirection: "down",
				},
			}),
		).toEqual({
			kind: "newTrack",
			trackType: "audio",
			insertIndex: 2,
			insertPosition: "below",
		});
	});
});
