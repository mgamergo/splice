import { getKeyframeById } from "@/animation";
import { getChannelEntriesFromData } from "@/animation/channel-data";
import { isScalarChannel } from "@/animation/interpolation";
import type { SelectedKeyframeRef } from "@/animation/types";
import type { TimelineClip } from "@/timeline";
import { PasteKeyframesCommand } from "@/commands/timeline";
import type {
	ClipboardHandler,
	KeyframeClipboardCurvePatch,
	KeyframeClipboardItem,
} from "../types";
import { roundMediaTime, subMediaTime, type MediaTime } from "@/wasm";

function resolveSingleSourceClip({
	selectedKeyframes,
}: {
	selectedKeyframes: SelectedKeyframeRef[];
}) {
	const firstKeyframe = selectedKeyframes[0];
	if (!firstKeyframe) {
		return null;
	}

	const sourceClip = {
		trackId: firstKeyframe.trackId,
		clipId: firstKeyframe.clipId,
	};
	const isSingleSource = selectedKeyframes.every(
		(keyframe) =>
			keyframe.trackId === sourceClip.trackId &&
			keyframe.clipId === sourceClip.clipId,
	);

	return isSingleSource ? sourceClip : null;
}

function getCurvePatches({
	clip,
	propertyPath,
	keyframeId,
}: {
	clip: TimelineClip;
	propertyPath: KeyframeClipboardItem["propertyPath"];
	keyframeId: string;
}): KeyframeClipboardCurvePatch[] {
	const data = clip.animations?.[propertyPath];
	if (!data) {
		return [];
	}

	return getChannelEntriesFromData({ data }).flatMap(([componentKey, channel]) => {
		if (!channel || !isScalarChannel(channel)) {
			return [];
		}

		const keyframe = channel.keys.find(
			(candidate) => candidate.id === keyframeId,
		);
		if (!keyframe) {
			return [];
		}

		return [
			{
				componentKey,
				patch: {
					leftHandle: keyframe.leftHandle ?? null,
					rightHandle: keyframe.rightHandle ?? null,
					segmentToNext: keyframe.segmentToNext,
					tangentMode: keyframe.tangentMode,
				},
			},
		];
	});
}

function buildClipboardItem({
	clip,
	propertyPath,
	keyframeId,
}: {
	clip: TimelineClip;
	propertyPath: KeyframeClipboardItem["propertyPath"];
	keyframeId: string;
}): (Omit<KeyframeClipboardItem, "timeOffset"> & { time: MediaTime }) | null {
	const keyframe = getKeyframeById({
		animations: clip.animations,
		propertyPath,
		keyframeId,
	});
	if (!keyframe) {
		return null;
	}

	return {
		propertyPath,
		time: keyframe.time,
		value: keyframe.value,
		interpolation: keyframe.interpolation,
		curvePatches: getCurvePatches({
			clip,
			propertyPath,
			keyframeId,
		}),
	};
}

export const KeyframesClipboardHandler = {
	type: "keyframes",

	canCopy({ selectedKeyframes }) {
		return selectedKeyframes.length > 0;
	},

	copy({ editor, selectedKeyframes }) {
		const sourceClip = resolveSingleSourceClip({ selectedKeyframes });
		if (!sourceClip) {
			return null;
		}

		const [result] = editor.timeline.getClipsWithTracks({
			clips: [sourceClip],
		});
		if (!result) {
			return null;
		}

		const rawItems = selectedKeyframes.flatMap((keyframeRef) => {
			const item = buildClipboardItem({
				clip: result.clip,
				propertyPath: keyframeRef.propertyPath,
				keyframeId: keyframeRef.keyframeId,
			});
			return item ? [item] : [];
		});
		if (rawItems.length === 0) {
			return null;
		}

		const minTime = Math.min(...rawItems.map((item) => item.time));
		const minTimeMedia = roundMediaTime({ time: minTime });
		const items = rawItems
			.map(({ time, ...item }) => ({
				...item,
				timeOffset: subMediaTime({ a: time, b: minTimeMedia }),
			}))
			.sort(
				(left, right) =>
					left.timeOffset - right.timeOffset ||
					left.propertyPath.localeCompare(right.propertyPath),
			);

		return {
			type: "keyframes",
			sourceClip,
			items,
		};
	},

	paste({
		entry,
		context: { selectedClips, time },
	}) {
		const targetClip = selectedClips[0];
		if (!targetClip || entry.items.length === 0) {
			return null;
		}

		return new PasteKeyframesCommand({
			trackId: targetClip.trackId,
			clipId: targetClip.clipId,
			time,
			clipboardItems: entry.items,
		});
	},
} satisfies ClipboardHandler<"keyframes">;
