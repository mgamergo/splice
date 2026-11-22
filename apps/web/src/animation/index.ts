export {
	getChannelValueAtTime,
	getDiscreteChannelValueAtTime,
	getScalarChannelValueAtTime,
	getScalarSegmentInterpolation,
	normalizeChannel,
} from "./interpolation";

export {
	clampAnimationsToDuration,
	cloneAnimations,
	getChannel,
	removeClipKeyframe,
	retimeClipKeyframe,
	setBindingComponentChannel,
	setChannel,
	splitAnimationsAtTime,
	updateScalarKeyframeCurve,
	upsertPathKeyframe,
} from "./keyframes";

export {
	getClipLocalTime,
	resolveAnimationPathValueAtTime,
} from "./resolve";

export {
	getClipKeyframes,
	getKeyframeById,
	getKeyframeAtTime,
	hasKeyframesForPath,
} from "./keyframe-query";

export {
	type EditableScalarChannels,
	getEditableScalarChannel,
	getEditableScalarChannels,
	getScalarKeyframeContext,
} from "./graph-channels";

export {
	getCurveHandlesForNormalizedCubicBezier,
	getNormalizedCubicBezierForScalarSegment,
} from "./curve-bridge";

export {
	buildGraphicParamPath,
	isGraphicParamPath,
	parseGraphicParamPath,
	resolveGraphicParamsAtTime,
} from "./graphic-param-channel";

export {
	buildEffectParamPath,
	isEffectParamPath,
	parseEffectParamPath,
	removeEffectParamKeyframe,
	resolveEffectParamsAtTime,
} from "./effect-param-channel";

export {
	getGroupKeyframesAtTime,
	hasGroupKeyframeAtTime,
	type GroupKeyframeRef,
} from "./property-groups";

export {
	isAnimationPath,
	isAnimationPropertyPath,
} from "./path";

export type { NumericSpec } from "./types";
