"use client";

import { useEditor } from "@/editor/use-editor";
import {
	buildGraphicParamPath,
	getKeyframeAtTime,
	hasKeyframesForPath,
	upsertPathKeyframe,
} from "@/animation";
import type {
	AnimationPath,
	ClipAnimations,
} from "@/animation/types";
import {
	coerceParamValue,
	getParamChannelLayout,
	type ParamDefinition,
} from "@/params";
import type { TimelineClip } from "@/timeline";
import type { MediaTime } from "@/wasm";

export interface KeyframedParamPropertyResult {
	hasAnimatedKeyframes: boolean;
	isKeyframedAtTime: boolean;
	keyframeIdAtTime: string | null;
	onPreview: (value: number | string | boolean) => void;
	onCommit: () => void;
	toggleKeyframe: () => void;
}

export function useKeyframedParamProperty({
	param,
	trackId,
	clipId,
	animations,
	propertyPath,
	localTime,
	isPlayheadWithinClipRange,
	resolvedValue,
	buildBaseUpdates,
}: {
	param: ParamDefinition;
	trackId: string;
	clipId: string;
	animations: ClipAnimations | undefined;
	propertyPath?: AnimationPath;
	localTime: MediaTime;
	isPlayheadWithinClipRange: boolean;
	resolvedValue: number | string | boolean;
	buildBaseUpdates: ({
		value,
	}: {
		value: number | string | boolean;
	}) => Partial<TimelineClip>;
}): KeyframedParamPropertyResult {
	const editor = useEditor();
	const resolvedPropertyPath =
		propertyPath ?? buildGraphicParamPath({ paramKey: param.key });
	const hasAnimatedKeyframes = hasKeyframesForPath({
		animations,
		propertyPath: resolvedPropertyPath,
	});
	const keyframeAtTime = isPlayheadWithinClipRange
		? getKeyframeAtTime({
				animations,
				propertyPath: resolvedPropertyPath,
				time: localTime,
			})
		: null;
	const keyframeIdAtTime = keyframeAtTime?.id ?? null;
	const isKeyframedAtTime = keyframeAtTime !== null;
	const shouldUseAnimatedChannel =
		hasAnimatedKeyframes && isPlayheadWithinClipRange;

	const previewValue: KeyframedParamPropertyResult["onPreview"] = (value) => {
		if (shouldUseAnimatedChannel) {
			editor.timeline.previewClips({
				updates: [
					{
						trackId,
						clipId,
						updates: {
							animations: upsertPathKeyframe({
								animations,
								propertyPath: resolvedPropertyPath,
								time: localTime,
								value,
								channelLayout: getParamChannelLayout({ param }),
								coerceValue: ({ value: nextValue }) =>
									coerceParamValue({
										param,
										value: nextValue,
									}),
							}),
						},
					},
				],
			});
			return;
		}

		editor.timeline.previewClips({
			updates: [
				{
					trackId,
					clipId,
					updates: buildBaseUpdates({ value }),
				},
			],
		});
	};

	const toggleKeyframe = () => {
		if (!isPlayheadWithinClipRange) {
			return;
		}

		if (keyframeIdAtTime) {
			editor.timeline.removeKeyframes({
				keyframes: [
					{
						trackId,
						clipId,
						propertyPath: resolvedPropertyPath,
						keyframeId: keyframeIdAtTime,
					},
				],
			});
			return;
		}

		editor.timeline.upsertKeyframes({
			keyframes: [
				{
					trackId,
					clipId,
					propertyPath: resolvedPropertyPath,
					time: localTime,
					value: resolvedValue,
				},
			],
		});
	};

	return {
		hasAnimatedKeyframes,
		isKeyframedAtTime,
		keyframeIdAtTime,
		onPreview: previewValue,
		onCommit: () => editor.timeline.commitPreview(),
		toggleKeyframe,
	};
}
