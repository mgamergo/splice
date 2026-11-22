import type {
	AnimationInterpolation,
	AnimationPath,
	NumericSpec,
} from "@/animation/types";
import {
	parseEffectParamPath,
} from "@/animation/effect-param-channel";
import {
	parseGraphicParamPath,
} from "@/animation/graphic-param-channel";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { getGraphicDefinition } from "@/graphics";
import {
	coerceParamValue,
	getParamDefaultInterpolation,
	getParamChannelLayout,
	getParamNumericRange,
	type ParamChannelLayout,
	type ParamDefinition,
	type ParamValue,
	type ParamValues,
} from "@/params";
import {
	getClipParam,
} from "@/params/registry";
import type { TimelineClip } from "@/timeline";
import { isVisualClip } from "@/timeline/clip-utils";

export interface AnimationPathDescriptor {
	channelLayout: ParamChannelLayout;
	defaultInterpolation: AnimationInterpolation;
	numericRanges?: Partial<Record<string, NumericSpec>>;
	coerceValue: ({ value }: { value: ParamValue }) => ParamValue | null;
	getBaseValue: () => ParamValue | null;
	setBaseValue: ({ value }: { value: ParamValue }) => TimelineClip;
}

// Leaf params expose a single component named "value". Composite params don't
// carry numeric ranges yet — revisit when one does.
function paramNumericRanges({
	param,
}: {
	param: ParamDefinition;
}): Partial<Record<string, NumericSpec>> | undefined {
	const range = getParamNumericRange({ param });
	return range ? { value: range } : undefined;
}

function buildParamDescriptor({
	param,
	baseParams,
	setParams,
}: {
	param: ParamDefinition;
	baseParams: ParamValues;
	setParams: (params: ParamValues) => TimelineClip;
}): AnimationPathDescriptor | null {
	if (param.keyframable === false) {
		return null;
	}

	return {
		channelLayout: getParamChannelLayout({ param }),
		defaultInterpolation: getParamDefaultInterpolation({ param }),
		numericRanges: paramNumericRanges({ param }),
		coerceValue: ({ value }) => coerceParamValue({ param, value }),
		getBaseValue: () => baseParams[param.key] ?? param.default,
		setBaseValue: ({ value }) => {
			const coercedValue = coerceParamValue({ param, value });
			if (coercedValue === null) {
				return setParams(baseParams);
			}

			return setParams({
				...baseParams,
				[param.key]: coercedValue,
			});
		},
	};
}

function buildClipParamDescriptor({
	clip,
	paramKey,
}: {
	clip: TimelineClip;
	paramKey: string;
}): AnimationPathDescriptor | null {
	const param = getClipParam({ clip, key: paramKey });
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: clip.params,
		setParams: (params) => ({
			...clip,
			params,
		}),
	});
}

function buildGraphicParamDescriptor({
	clip,
	paramKey,
}: {
	clip: TimelineClip;
	paramKey: string;
}): AnimationPathDescriptor | null {
	if (clip.type !== "graphic") {
		return null;
	}

	const definition = getGraphicDefinition({
		definitionId: clip.definitionId,
	});
	const param = definition.params.find((candidate) => candidate.key === paramKey);
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: clip.params,
		setParams: (params) => ({
			...clip,
			params,
		}),
	});
}

function buildEffectParamDescriptor({
	clip,
	effectId,
	paramKey,
}: {
	clip: TimelineClip;
	effectId: string;
	paramKey: string;
}): AnimationPathDescriptor | null {
	if (!isVisualClip(clip)) {
		return null;
	}

	const effect = clip.effects?.find((candidate) => candidate.id === effectId);
	if (!effect) {
		return null;
	}

	registerDefaultEffects();
	const definition = effectsRegistry.get(effect.type);
	const param = definition.params.find((candidate) => candidate.key === paramKey);
	if (!param) {
		return null;
	}

	return buildParamDescriptor({
		param,
		baseParams: effect.params,
		setParams: (params) => ({
			...clip,
			effects:
				clip.effects?.map((candidate) =>
					candidate.id !== effectId
						? candidate
						: {
								...candidate,
								params,
							},
				) ?? clip.effects,
		}),
	});
}

export function resolveAnimationTarget({
	clip,
	path,
}: {
	clip: TimelineClip;
	path: AnimationPath;
}): AnimationPathDescriptor | null {
	const clipParamTarget = buildClipParamDescriptor({
		clip,
		paramKey: path,
	});
	if (clipParamTarget) {
		return clipParamTarget;
	}

	const graphicParamTarget = parseGraphicParamPath({ propertyPath: path });
	if (graphicParamTarget) {
		return buildGraphicParamDescriptor({
			clip,
			paramKey: graphicParamTarget.paramKey,
		});
	}

	const effectParamTarget = parseEffectParamPath({ propertyPath: path });
	if (effectParamTarget) {
		return buildEffectParamDescriptor({
			clip,
			effectId: effectParamTarget.effectId,
			paramKey: effectParamTarget.paramKey,
		});
	}

	return null;
}
