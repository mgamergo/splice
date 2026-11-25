import { CAPTION_TRACK_NAME } from "@/agent/short-captions";
import { cuesToSrt } from "@/captions/cues";
import type { SequenceTracks } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";

const seconds = (time: SequenceTracks["main"]["clips"][number]["startTime"]) =>
	mediaTimeToSeconds({ time });

/** Uses the exact caption clips the export burns in, including direct corrections. */
export function shortSrt({ tracks }: { tracks: SequenceTracks }): string {
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
		.sort((a, b) => a.start - b.start);
	return cuesToSrt(cues);
}
