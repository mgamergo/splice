import type { SequenceTracks, TimelineClip } from "@/timeline";
import type { ProjectItem } from "@/media/types";
import { STICKER_INTRINSIC_SIZE_FALLBACK } from "@/stickers/intrinsic-size";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics";
import { measureTextClip } from "@/text/measure-clip";
import {
	getClipLocalTime,
} from "@/animation";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildTransformFromParams } from "@/rendering";

export interface ClipBounds {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
}

export interface ClipWithBounds {
	trackId: string;
	clipId: string;
	clip: TimelineClip;
	bounds: ClipBounds;
}

function getVisualClipBounds({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	transform: {
		scaleX: number;
		scaleY: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ClipBounds {
	const containScale = Math.min(
		canvasWidth / sourceWidth,
		canvasHeight / sourceHeight,
	);
	const scaledWidth = sourceWidth * containScale * transform.scaleX;
	const scaledHeight = sourceHeight * containScale * transform.scaleY;
	const cx = canvasWidth / 2 + transform.position.x;
	const cy = canvasHeight / 2 + transform.position.y;

	return {
		cx,
		cy,
		width: scaledWidth,
		height: scaledHeight,
		rotation: transform.rotate,
	};
}

function getTransformedRectBounds({
	canvasWidth,
	canvasHeight,
	rect,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	rect: { left: number; top: number; width: number; height: number };
	transform: {
		scaleX: number;
		scaleY: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ClipBounds {
	const localCenterX = rect.left + rect.width / 2;
	const localCenterY = rect.top + rect.height / 2;
	const scaledCenterX = localCenterX * transform.scaleX;
	const scaledCenterY = localCenterY * transform.scaleY;
	const rotationRad = (transform.rotate * Math.PI) / 180;
	const cos = Math.cos(rotationRad);
	const sin = Math.sin(rotationRad);
	return {
		cx:
			canvasWidth / 2 +
			transform.position.x +
			scaledCenterX * cos -
			scaledCenterY * sin,
		cy:
			canvasHeight / 2 +
			transform.position.y +
			scaledCenterX * sin +
			scaledCenterY * cos,
		width: rect.width * transform.scaleX,
		height: rect.height * transform.scaleY,
		rotation: transform.rotate,
	};
}

/**
 * Bounds policy: bounds reflect base content geometry (text glyphs + background,
 * sticker/image/video content area) and base transform. Post-effect spill (blur,
 * glow) and mask-clipped regions are intentionally excluded — handles manipulate
 * the canonical clip geometry, not visual effect output.
 */
function getClipBounds({
	clip,
	canvasSize,
	projectItem,
	localTime,
}: {
	clip: TimelineClip;
	canvasSize: { width: number; height: number };
	projectItem?: ProjectItem | null;
	localTime: number;
}): ClipBounds | null {
	if (clip.type === "audio" || clip.type === "effect") return null;
	if ("hidden" in clip && clip.hidden) return null;

	const { width: canvasWidth, height: canvasHeight } = canvasSize;

	if (clip.type === "video" || clip.type === "image") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: clip.params }),
			animations: clip.animations,
			localTime,
		});
		const sourceWidth = projectItem?.width ?? canvasWidth;
		const sourceHeight = projectItem?.height ?? canvasHeight;
		return getVisualClipBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth,
			sourceHeight,
			transform,
		});
	}

	if (clip.type === "sticker") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: clip.params }),
			animations: clip.animations,
			localTime,
		});
		return getVisualClipBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: clip.intrinsicWidth ?? STICKER_INTRINSIC_SIZE_FALLBACK,
			sourceHeight: clip.intrinsicHeight ?? STICKER_INTRINSIC_SIZE_FALLBACK,
			transform,
		});
	}

	if (clip.type === "graphic") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: clip.params }),
			animations: clip.animations,
			localTime,
		});
		return getVisualClipBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: DEFAULT_GRAPHIC_SOURCE_SIZE,
			sourceHeight: DEFAULT_GRAPHIC_SOURCE_SIZE,
			transform,
		});
	}

	if (clip.type === "text") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: clip.params }),
			animations: clip.animations,
			localTime,
		});

		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;

		const measured = measureTextClip({
			clip,
			canvasHeight,
			localTime,
			ctx,
		});

		return getTransformedRectBounds({
			canvasWidth,
			canvasHeight,
			rect: measured.visualRect,
			transform,
		});
	}

	return null;
}

export const ROTATION_HANDLE_OFFSET = 24;

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Edge = "right" | "left" | "bottom";

export function getCornerPosition({
	bounds,
	corner,
}: {
	bounds: ClipBounds;
	corner: Corner;
}): { x: number; y: number } {
	const halfW = bounds.width / 2;
	const halfH = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const localX =
		corner === "top-left" || corner === "bottom-left" ? -halfW : halfW;
	const localY =
		corner === "top-left" || corner === "top-right" ? -halfH : halfH;
	return {
		x: bounds.cx + (localX * cos - localY * sin),
		y: bounds.cy + (localX * sin + localY * cos),
	};
}

export function getEdgeHandlePosition({
	bounds,
	edge,
}: {
	bounds: ClipBounds;
	edge: Edge;
}): { x: number; y: number } {
	const halfWidth = bounds.width / 2;
	const halfHeight = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const localX = edge === "right" ? halfWidth : edge === "left" ? -halfWidth : 0;
	const localY = edge === "bottom" ? halfHeight : 0;
	return {
		x: bounds.cx + (localX * cos - localY * sin),
		y: bounds.cy + (localX * sin + localY * cos),
	};
}

export function getVisibleClipsWithBounds({
	tracks,
	currentTime,
	canvasSize,
	projectItems,
}: {
	tracks: SequenceTracks;
	currentTime: number;
	canvasSize: { width: number; height: number };
	projectItems: ProjectItem[];
}): ClipWithBounds[] {
	const mediaMap = new Map(projectItems.map((m) => [m.id, m]));
	const orderedTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	].reverse();

	const result: ClipWithBounds[] = [];

	for (const track of orderedTracks) {
		const clips = track.clips
			.filter((clip) => !("hidden" in clip && clip.hidden))
			.filter(
				(clip) =>
					currentTime >= clip.startTime &&
					currentTime < clip.startTime + clip.duration,
			)
			.slice()
			.sort((a, b) => {
				if (a.startTime !== b.startTime) return a.startTime - b.startTime;
				return a.id.localeCompare(b.id);
			});

		for (const clip of clips) {
			const localTime = getClipLocalTime({
				timelineTime: currentTime,
				clipStartTime: clip.startTime,
				clipDuration: clip.duration,
			});
			const projectItem =
				clip.type === "video" || clip.type === "image"
					? mediaMap.get(clip.mediaId)
					: undefined;
			const bounds = getClipBounds({
				clip,
				canvasSize,
				projectItem,
				localTime,
			});
			if (bounds) {
				result.push({
					trackId: track.id,
					clipId: clip.id,
					clip,
					bounds,
				});
			}
		}
	}

	return result;
}
