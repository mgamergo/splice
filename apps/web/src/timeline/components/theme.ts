import type { TrackType } from "@/timeline";

export const TIMELINE_AUDIO_WAVEFORM_COLOR = "rgba(255, 255, 255, 0.7)";

export const TIMELINE_TRACK_THEME: Record<
	TrackType,
	{
		clipClassName: string;
		waveformColor?: string;
	}
> = {
	video: { clipClassName: "transparent" },
	text: { clipClassName: "bg-[#5DBAA0]" },
	audio: {
		clipClassName: "bg-[#8F5DBA]",
		waveformColor: TIMELINE_AUDIO_WAVEFORM_COLOR,
	},
	graphic: { clipClassName: "bg-[#BA5D7A]" },
	effect: { clipClassName: "bg-[#5d93ba]" },
} as const;

export const SELECTED_TRACK_ROW_CLASS = "bg-accent/50";
export const DEFAULT_TIMELINE_MARKER_COLOR = "#009dff";

export function getTimelineClipClassName({
	type,
}: {
	type: TrackType;
}): string {
	return TIMELINE_TRACK_THEME[type].clipClassName.trim();
}
