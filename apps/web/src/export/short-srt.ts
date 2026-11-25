import { CAPTION_TRACK_NAME } from "@/agent/short-captions";
import { serializeCuesToSrt } from "@/captions/cues";
import type { SequenceTracks } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";

const seconds = (time: SequenceTracks["main"]["clips"][number]["startTime"]) =>
	mediaTimeToSeconds({ time });

/** Reads the caption clips the export burns in, including direct corrections. */
export function shortCaptionDelivery({ tracks }: { tracks: SequenceTracks }) {
	const cues = tracks.overlay
		.flatMap((track) =>
			track.type === "text" &&
			track.name === CAPTION_TRACK_NAME &&
			!track.hidden
				? track.clips
						.filter((clip) => !clip.hidden)
						.map((clip) => ({
							start: seconds(clip.startTime),
							end: seconds(clip.startTime) + seconds(clip.duration),
							text: String(clip.params.content ?? "")
								.trim()
								.replace(/\s+/g, " "),
						}))
				: [],
		)
		.filter(({ text }) => text.length > 0)
		.sort((a, b) => a.start - b.start);
	return {
		srt: serializeCuesToSrt({ cues, preserveOverlaps: true }),
		cueCount: cues.length,
	};
}

export function shortSrt({ tracks }: { tracks: SequenceTracks }): string {
	return shortCaptionDelivery({ tracks }).srt;
}
