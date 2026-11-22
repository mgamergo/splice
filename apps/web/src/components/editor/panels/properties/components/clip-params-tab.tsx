"use client";

import { resolveAnimationPathValueAtTime } from "@/animation";
import { Section, SectionContent, SectionFields } from "@/components/section";
import { useClipPlayhead } from "@/components/editor/panels/properties/hooks/use-clip-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import type { ParamValue, ParamValues } from "@/params";
import {
	getClipParams,
	readClipParamValue,
	writeClipParamValue,
	type ClipParamDefinition,
} from "@/params/registry";
import type { TimelineClip } from "@/timeline";
import type { MediaTime } from "@/wasm";

export function ClipParamsTab({
	clip,
	trackId,
	paramKeys,
	sectionKey,
}: {
	clip: TimelineClip;
	trackId: string;
	paramKeys?: readonly string[];
	sectionKey: string;
}) {
	const { localTime, isPlayheadWithinClipRange } = useClipPlayhead({
		startTime: clip.startTime,
		duration: clip.duration,
	});
	const params = getClipParams({ clip }).filter(
		(param) => !paramKeys || paramKeys.includes(param.key),
	);
	const baseValues = buildValues({ clip, params });

	return (
		<Section sectionKey={`${clip.id}:${sectionKey}`}>
			<SectionContent className="pt-4">
				<SectionFields>
					{params
						.filter((param) => isVisible({ param, values: baseValues }))
						.map((param) => (
							<ClipParamField
								key={param.key}
								clip={clip}
								trackId={trackId}
								param={param}
								baseValue={baseValues[param.key] ?? param.default}
								localTime={localTime}
								isPlayheadWithinClipRange={isPlayheadWithinClipRange}
							/>
						))}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function ClipParamField({
	clip,
	trackId,
	param,
	baseValue,
	localTime,
	isPlayheadWithinClipRange,
}: {
	clip: TimelineClip;
	trackId: string;
	param: ClipParamDefinition;
	baseValue: ParamValue;
	localTime: MediaTime;
	isPlayheadWithinClipRange: boolean;
}) {
	const resolvedValue = resolveAnimationPathValueAtTime({
		animations: clip.animations,
		propertyPath: param.key,
		localTime,
		fallbackValue: baseValue,
	});
	const animatedParam = useKeyframedParamProperty({
		param,
		trackId,
		clipId: clip.id,
		animations: clip.animations,
		propertyPath: param.key,
		localTime,
		isPlayheadWithinClipRange,
		resolvedValue,
		buildBaseUpdates: ({ value }) =>
			writeClipParamValue({ clip, param, value }),
	});

	return (
		<PropertyParamField
			param={param}
			value={resolvedValue}
			onPreview={animatedParam.onPreview}
			onCommit={animatedParam.onCommit}
			keyframe={
				param.keyframable === false
					? undefined
					: {
							isActive: animatedParam.isKeyframedAtTime,
							isDisabled: !isPlayheadWithinClipRange,
							onToggle: animatedParam.toggleKeyframe,
						}
			}
		/>
	);
}

function buildValues({
	clip,
	params,
}: {
	clip: TimelineClip;
	params: readonly ClipParamDefinition[];
}): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		const value = readClipParamValue({ clip, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

function isVisible({
	param,
	values,
}: {
	param: ClipParamDefinition;
	values: ParamValues;
}): boolean {
	return (param.dependencies ?? []).every((dependency) =>
		areParamValuesEqual({
			left: values[dependency.param],
			right: dependency.equals,
		}),
	);
}

function areParamValuesEqual({
	left,
	right,
}: {
	left: ParamValue | undefined;
	right: ParamValue;
}): boolean {
	return left === right;
}
