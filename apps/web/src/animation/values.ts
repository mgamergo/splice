import type {
	AnimationColorPropertyPath,
	AnimationNumericPropertyPath,
	ClipAnimations,
} from "./types";
import { resolveAnimationPathValueAtTime } from "./resolve";

export function resolveOpacityAtTime({
	baseOpacity,
	animations,
	localTime,
}: {
	baseOpacity: number;
	animations: ClipAnimations | undefined;
	localTime: number;
}): number {
	return resolveAnimationPathValueAtTime({
		animations,
		propertyPath: "opacity",
		localTime: Math.max(0, localTime),
		fallbackValue: baseOpacity,
	});
}

export function resolveNumberAtTime({
	baseValue,
	animations,
	propertyPath,
	localTime,
}: {
	baseValue: number;
	animations: ClipAnimations | undefined;
	propertyPath: AnimationNumericPropertyPath;
	localTime: number;
}): number {
	return resolveAnimationPathValueAtTime({
		animations,
		propertyPath,
		localTime: Math.max(0, localTime),
		fallbackValue: baseValue,
	});
}

export function resolveColorAtTime({
	baseColor,
	animations,
	propertyPath,
	localTime,
}: {
	baseColor: string;
	animations: ClipAnimations | undefined;
	propertyPath: AnimationColorPropertyPath;
	localTime: number;
}): string {
	return resolveAnimationPathValueAtTime({
		animations,
		propertyPath,
		localTime: Math.max(0, localTime),
		fallbackValue: baseColor,
	});
}
