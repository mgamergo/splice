import { clampAnimationsToDuration } from "@/animation";
import {
	clampRetimeRate,
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import type { RetimeConfig, SequenceTracks, TimelineClip } from "@/timeline";
import { isRetimableClip } from "@/timeline";
import { ZERO_MEDIA_TIME, roundMediaTime } from "@/wasm";

type ClipUpdateField = keyof TimelineClip | string;

export interface ClipUpdateContext {
	tracks: SequenceTracks;
	trackId: string;
}

interface ClipUpdateRuleResult {
	clip: TimelineClip;
	changedFields?: ClipUpdateField[];
}

interface ClipUpdateRuleParams {
	clip: TimelineClip;
	originalClip: TimelineClip;
	patch: Partial<TimelineClip>;
	context: ClipUpdateContext;
}

interface ClipUpdateRule {
	triggers: ClipUpdateField[];
	apply: (params: ClipUpdateRuleParams) => ClipUpdateRuleResult;
}

const deriveRules: ClipUpdateRule[] = [
	{
		triggers: ["retime"],
		apply: ({ clip, originalClip, patch }) => {
			if (!("retime" in patch) || !isRetimableClip(clip)) {
				return { clip };
			}

			const nextRetime = patch.retime
				? {
						...patch.retime,
						rate: clampRetimeRate({ rate: patch.retime.rate }),
					}
				: undefined;

			const sourceDuration = getSourceDuration({
				trimStart: originalClip.trimStart,
				trimEnd: originalClip.trimEnd,
				duration: originalClip.duration,
				sourceDuration: isRetimableClip(originalClip)
					? originalClip.sourceDuration
					: undefined,
				retime: isRetimableClip(originalClip)
					? originalClip.retime
					: undefined,
			});
			const visibleSourceSpan = Math.max(
				0,
				sourceDuration - clip.trimStart - clip.trimEnd,
			);
			const nextDuration = roundMediaTime({
				time: getTimelineDurationForSourceSpan({
					sourceSpan: visibleSourceSpan,
					retime: nextRetime,
				}),
			});

			return {
				clip: {
					...clip,
					retime: nextRetime,
					duration: nextDuration,
				},
				changedFields: ["retime", "duration"],
			};
		},
	},
];

const enforceRules: ClipUpdateRule[] = [
	{
		triggers: ["duration"],
		apply: ({ clip }) => ({
			clip: {
				...clip,
				animations: clampAnimationsToDuration({
					animations: clip.animations,
					duration: clip.duration,
				}),
			},
		}),
	},
	{
		triggers: ["startTime"],
		apply: ({ clip, context }) => {
			const requestedStartTime =
				clip.startTime < ZERO_MEDIA_TIME
					? ZERO_MEDIA_TIME
					: clip.startTime;
			if (context.trackId !== context.tracks.main.id) {
				return {
					clip: {
						...clip,
						startTime: requestedStartTime,
					},
				};
			}

			const earliestClip = context.tracks.main.clips
				.filter((candidate) => candidate.id !== clip.id)
				.reduce<TimelineClip | null>((earliest, candidate) => {
					if (!earliest || candidate.startTime < earliest.startTime) {
						return candidate;
					}
					return earliest;
				}, null);

			return {
				clip: {
					...clip,
					startTime:
						!earliestClip || requestedStartTime <= earliestClip.startTime
							? ZERO_MEDIA_TIME
							: requestedStartTime,
				},
			};
		},
	},
];

export function applyClipUpdate({
	clip,
	patch,
	context,
}: {
	clip: TimelineClip;
	patch: Partial<TimelineClip>;
	context: ClipUpdateContext;
}): TimelineClip {
	let nextClip = {
		...clip,
		...patch,
		params: {
			...clip.params,
			...(patch.params ?? {}),
		},
	} as TimelineClip;
	const changedFields = new Set(
		Object.keys(patch) as ClipUpdateField[],
	);

	for (const rule of deriveRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		const result = rule.apply({
			clip: nextClip,
			originalClip: clip,
			patch,
			context,
		});
		nextClip = result.clip;
		for (const field of result.changedFields ?? []) {
			changedFields.add(field);
		}
	}

	for (const rule of enforceRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		nextClip = rule.apply({
			clip: nextClip,
			originalClip: clip,
			patch,
			context,
		}).clip;
	}

	return nextClip;
}

function shouldApplyRule({
	rule,
	changedFields,
}: {
	rule: ClipUpdateRule;
	changedFields: Set<ClipUpdateField>;
}): boolean {
	return rule.triggers.some((trigger) => changedFields.has(trigger));
}

function getSourceDuration({
	trimStart,
	trimEnd,
	duration,
	sourceDuration,
	retime,
}: {
	trimStart: number;
	trimEnd: number;
	duration: number;
	sourceDuration?: number;
	retime?: RetimeConfig;
}): number {
	if (typeof sourceDuration === "number") {
		return sourceDuration;
	}

	return (
		trimStart +
		getSourceSpanAtClipTime({
			clipTime: duration,
			retime,
		}) +
		trimEnd
	);
}
