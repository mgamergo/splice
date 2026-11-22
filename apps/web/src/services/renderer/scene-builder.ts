import type { SequenceTracks, TimelineTrack } from "@/timeline";
import type { ProjectItem } from "@/media/types";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleSortedClips({ track }: { track: TimelineTrack }) {
	return track.clips
		.filter((clip) => !("hidden" in clip && clip.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, ProjectItem>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const clips = getVisibleSortedClips({ track });

		for (const clip of clips) {
			if (clip.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: clip.effectType,
						effectParams: clip.params,
						timeOffset: clip.startTime,
						duration: clip.duration,
					}),
				);
				continue;
			}

			if (clip.type === "video" || clip.type === "image") {
				const projectItem = mediaMap.get(clip.mediaId);
				if (!projectItem?.file || !projectItem?.url) {
					continue;
				}

				if (clip.type === "video" && projectItem.type === "video") {
					nodes.push(
						new VideoNode({
							mediaId: projectItem.id,
							url: projectItem.url,
							file: projectItem.file,
							duration: clip.duration,
							timeOffset: clip.startTime,
							trimStart: clip.trimStart,
							trimEnd: clip.trimEnd,
							retime: clip.retime,
							transform: buildTransformFromParams({ params: clip.params }),
							animations: clip.animations,
							opacity: readOpacityFromParams({ params: clip.params }),
							blendMode: readBlendModeFromParams({ params: clip.params }),
							effects: clip.effects ?? [],
							masks: clip.masks ?? [],
						}),
					);
				}
				if (clip.type === "image" && projectItem.type === "image") {
					nodes.push(
						new ImageNode({
							url: projectItem.url,
							duration: clip.duration,
							timeOffset: clip.startTime,
							trimStart: clip.trimStart,
							trimEnd: clip.trimEnd,
							transform: buildTransformFromParams({ params: clip.params }),
							animations: clip.animations,
							opacity: readOpacityFromParams({ params: clip.params }),
							blendMode: readBlendModeFromParams({ params: clip.params }),
							effects: clip.effects ?? [],
							masks: clip.masks ?? [],
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
			}

			if (clip.type === "text") {
				nodes.push(
					new TextNode({
						...clip,
						transform: buildTransformFromParams({ params: clip.params }),
						opacity: readOpacityFromParams({ params: clip.params }),
						blendMode: readBlendModeFromParams({ params: clip.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: clip.effects ?? [],
					}),
				);
			}

			if (clip.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: clip.stickerId,
						intrinsicWidth: clip.intrinsicWidth,
						intrinsicHeight: clip.intrinsicHeight,
						duration: clip.duration,
						timeOffset: clip.startTime,
						trimStart: clip.trimStart,
						trimEnd: clip.trimEnd,
						transform: buildTransformFromParams({ params: clip.params }),
						animations: clip.animations,
						opacity: readOpacityFromParams({ params: clip.params }),
						blendMode: readBlendModeFromParams({ params: clip.params }),
						effects: clip.effects ?? [],
					}),
				);
			}

			if (clip.type === "graphic") {
				nodes.push(
					new GraphicNode({
						definitionId: clip.definitionId,
						params: clip.params,
						duration: clip.duration,
						timeOffset: clip.startTime,
						trimStart: clip.trimStart,
						trimEnd: clip.trimEnd,
						transform: buildTransformFromParams({ params: clip.params }),
						animations: clip.animations,
						opacity: readOpacityFromParams({ params: clip.params }),
						blendMode: readBlendModeFromParams({ params: clip.params }),
						effects: clip.effects ?? [],
						masks: clip.masks ?? [],
					}),
				);
			}
		}
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, ProjectItem>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const clips = getVisibleSortedClips({ track });

	for (const clip of clips) {
		if (clip.type !== "video" && clip.type !== "image") {
			continue;
		}

		const projectItem = mediaMap.get(clip.mediaId);
		if (
			!projectItem?.file ||
			!projectItem?.url ||
			(projectItem.type !== "video" && projectItem.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: projectItem.id,
				url: projectItem.url,
				file: projectItem.file,
				mediaType: projectItem.type,
				duration: clip.duration,
				timeOffset: clip.startTime,
				trimStart: clip.trimStart,
				trimEnd: clip.trimEnd,
				retime: clip.type === "video" ? clip.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
};

export function buildScene({
	canvasSize,
	tracks,
	projectItems,
	duration,
	background,
	isPreview,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(projectItems.map((m) => [m.id, m]));

	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	const orderedTracksBottomToTop = visibleTracks.slice().reverse();
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		mediaMap,
		canvasSize,
		isPreview,
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
