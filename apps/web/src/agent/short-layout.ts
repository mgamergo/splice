import { recoverCaptionLayouts } from "@/agent/captions";
import type { ShortStyle } from "@splice/bridge";
import { graphicActionRegions } from "@/agent/graphics";
import { placeShortCaptions } from "@/agent/short-captions";
import { isHookTrack } from "@/agent/short-hook";
import { textBounds } from "@/agent/overlay-bounds";
import type { ProjectItem } from "@/media/types";
import type { TCanvasSize } from "@/project/types";
import type { TSequence } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";

export function layoutShort({
	sequence,
	style,
	canvas,
	projectItems,
	updateHookVisibility = false,
}: {
	sequence: Pick<TSequence, "tracks" | "graphics" | "captions">;
	style: ShortStyle;
	canvas: TCanvasSize;
	projectItems: ProjectItem[];
	updateHookVisibility?: boolean;
}) {
	const tracks = recoverCaptionLayouts({
		tracks: sequence.tracks,
		captions: sequence.captions,
		canvasSize: canvas,
	});
	const overlay = tracks.overlay.map((track) =>
		updateHookVisibility &&
		isHookTrack(track) &&
		track.hidden !== (style !== "raw")
			? { ...track, hidden: style !== "raw" }
			: track,
	);
	const textOverlays = overlay.flatMap((track) => {
		if (track.type !== "text" || track.hidden) return [];
		return track.clips
			.filter((clip) => !clip.hidden && (isHookTrack(track) || clip.graphicId))
			.map((clip) => ({
				...textBounds({ clip, canvas }),
				start: mediaTimeToSeconds({ time: clip.startTime }),
				end:
					mediaTimeToSeconds({ time: clip.startTime }) +
					mediaTimeToSeconds({ time: clip.duration }),
			}));
	});
	return placeShortCaptions({
		tracks: overlay.some((track, index) => track !== tracks.overlay[index])
			? { ...tracks, overlay }
			: tracks,
		canvas,
		style,
		position: sequence.captions?.style?.position,
		regions: [
			...graphicActionRegions({ sequence, projectItems, canvas }),
			...textOverlays,
		],
	});
}
