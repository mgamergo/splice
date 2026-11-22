"use client";

import { useRef } from "react";
import { useClipPlayhead } from "@/components/editor/panels/properties/hooks/use-clip-playhead";
import {
	useKeyframedParamProperty,
	type KeyframedParamPropertyResult,
} from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import type { ParamDefinition, ParamValues } from "@/params";
import type { GraphicClip } from "@/timeline";
import { graphicsRegistry, registerDefaultGraphics, resolveGraphicClipParamsAtTime } from "@/graphics";
import { useClipPreview } from "@/timeline/hooks/use-clip-preview";
import { useEditor } from "@/editor/use-editor";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";
import type { MediaTime } from "@/wasm";

registerDefaultGraphics();

const DEFAULT_STROKE_WIDTH = 2;

export function GraphicTab({
	clip,
	trackId,
}: {
	clip: GraphicClip;
	trackId: string;
}) {
	const definition = graphicsRegistry.get(clip.definitionId);
	const { localTime, isPlayheadWithinClipRange } = useClipPlayhead({
		startTime: clip.startTime,
		duration: clip.duration,
	});
	const { renderClip } = useClipPreview({
		trackId,
		clipId: clip.id,
		fallback: clip,
	});

	const liveClip = renderClip as GraphicClip;
	const resolvedParams = resolveGraphicClipParamsAtTime({
		clip: liveClip,
		localTime,
	});

	const shapeParams = definition.params.filter((p) => p.group !== "stroke");
	const hasStrokeParams = definition.params.some((p) => p.group === "stroke");

	return (
		<div className="flex flex-col">
			<Section collapsible sectionKey={`${clip.id}:graphic`}>
				<SectionHeader>
					<SectionTitle>{definition.name}</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						{shapeParams.map((param) => (
							<AnimatedGraphicParamField
								key={param.key}
								param={param}
								trackId={trackId}
								clip={liveClip}
								localTime={localTime}
								isPlayheadWithinClipRange={isPlayheadWithinClipRange}
								resolvedParams={resolvedParams}
							/>
						))}
					</SectionFields>
				</SectionContent>
			</Section>
			{hasStrokeParams && <StrokeSection clip={clip} trackId={trackId} />}
		</div>
	);
}

function StrokeSection({
	clip,
	trackId,
}: {
	clip: GraphicClip;
	trackId: string;
}) {
	const editor = useEditor();
	const definition = graphicsRegistry.get(clip.definitionId);
	const { localTime, isPlayheadWithinClipRange } = useClipPlayhead({
		startTime: clip.startTime,
		duration: clip.duration,
	});
	const { renderClip } = useClipPreview({
		trackId,
		clipId: clip.id,
		fallback: clip,
	});

	const liveClip = renderClip as GraphicClip;
	const resolvedParams = resolveGraphicClipParamsAtTime({
		clip: liveClip,
		localTime,
	});
	const strokeParams = definition.params.filter((p) => p.group === "stroke");
	const lastStrokeWidth = useRef(DEFAULT_STROKE_WIDTH);
	const isStrokeEnabled = Number(clip.params.strokeWidth ?? 0) > 0;

	const toggleStroke = () => {
		if (isStrokeEnabled) {
			lastStrokeWidth.current = Number(
				clip.params.strokeWidth ?? DEFAULT_STROKE_WIDTH,
			);
			editor.timeline.updateClips({
				updates: [
					{
						trackId,
						clipId: clip.id,
						patch: { params: { ...clip.params, strokeWidth: 0 } },
					},
				],
			});
		} else {
			editor.timeline.updateClips({
				updates: [
					{
						trackId,
						clipId: clip.id,
						patch: {
							params: {
								...clip.params,
								strokeWidth: lastStrokeWidth.current,
							},
						},
					},
				],
			});
		}
	};

	return (
		<Section
			collapsible
			defaultOpen={isStrokeEnabled}
			sectionKey={`${clip.id}:stroke`}
		>
			<SectionHeader
				trailing={
					<Button
						variant="ghost"
						size="icon"
						onClick={(event) => {
							event.stopPropagation();
							toggleStroke();
						}}
					>
						<HugeiconsIcon
							icon={isStrokeEnabled ? MinusSignIcon : PlusSignIcon}
							strokeWidth={1}
						/>
					</Button>
				}
			>
				<SectionTitle>Stroke</SectionTitle>
			</SectionHeader>
			<SectionContent
				className={cn(!isStrokeEnabled && "pointer-events-none opacity-50")}
			>
				<SectionFields>
					{strokeParams.map((param) => (
						<AnimatedGraphicParamField
							key={param.key}
							param={param}
							trackId={trackId}
							clip={liveClip}
							localTime={localTime}
							isPlayheadWithinClipRange={isPlayheadWithinClipRange}
							resolvedParams={resolvedParams}
						/>
					))}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function AnimatedGraphicParamField({
	param,
	trackId,
	clip,
	localTime,
	isPlayheadWithinClipRange,
	resolvedParams,
}: {
	key?: string;
	param: ParamDefinition;
	trackId: string;
	clip: GraphicClip;
	localTime: MediaTime;
	isPlayheadWithinClipRange: boolean;
	resolvedParams: ParamValues;
}) {
	const animatedParam: KeyframedParamPropertyResult = useKeyframedParamProperty(
		{
			param,
			trackId,
			clipId: clip.id,
			animations: clip.animations,
			localTime,
			isPlayheadWithinClipRange,
			resolvedValue: resolvedParams[param.key] ?? param.default,
			buildBaseUpdates: ({ value }) => ({
				params: {
					...clip.params,
					[param.key]: value,
				},
			}),
		},
	);

	return (
		<PropertyParamField
			param={param}
			value={resolvedParams[param.key] ?? param.default}
			onPreview={animatedParam.onPreview}
			onCommit={animatedParam.onCommit}
			keyframe={{
				isActive: animatedParam.isKeyframedAtTime,
				isDisabled: !isPlayheadWithinClipRange,
				onToggle: animatedParam.toggleKeyframe,
			}}
		/>
	);
}
