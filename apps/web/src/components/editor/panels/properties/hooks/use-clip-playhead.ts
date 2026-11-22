import { useEditor } from "@/editor/use-editor";
import { getClipLocalTime } from "@/animation";
import { addMediaTime, mediaTime, type MediaTime } from "@/wasm";

export function useClipPlayhead({
	startTime,
	duration,
}: {
	startTime: MediaTime;
	duration: MediaTime;
}) {
	const playheadTime = useEditor((editor) => editor.playback.getCurrentTime());
	const localTime = mediaTime({
		ticks: getClipLocalTime({
			timelineTime: playheadTime,
			clipStartTime: startTime,
			clipDuration: duration,
		}),
	});
	const isPlayheadWithinClipRange =
		playheadTime >= startTime &&
		playheadTime <= addMediaTime({ a: startTime, b: duration });

	return { localTime, isPlayheadWithinClipRange };
}
