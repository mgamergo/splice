import { buildTransformFromParams } from "@/rendering";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import {
	getTextMeasurementContext,
	measureTextClip,
} from "@/text/measure-clip";
import type { TextClip } from "@/timeline/types";
import type { TCanvasSize } from "@/project/types";

export interface CanvasRect {
	center: { x: number; y: number };
	width: number;
	height: number;
}

export interface OverlayRegion extends CanvasRect {
	start: number;
	end: number;
}

export function textBounds({
	clip,
	canvas,
}: {
	clip: TextClip;
	canvas: TCanvasSize;
}): CanvasRect {
	const { position, scaleX, scaleY } = buildTransformFromParams({
		params: clip.params,
	});
	const fontPixels =
		(Number(clip.params.fontSize) * canvas.height) / FONT_SIZE_SCALE_REFERENCE;
	const lines = String(clip.params.content ?? "").split("\n");
	const width =
		Math.max(...lines.map(({ length }) => length)) * fontPixels * 0.6;
	const height =
		lines.length * fontPixels * Number(clip.params.lineHeight ?? 1.2);
	const rect =
		typeof document === "undefined" && typeof OffscreenCanvas === "undefined"
			? { left: -width / 2, top: -height / 2, width, height }
			: measureTextClip({
					clip,
					canvasHeight: canvas.height,
					localTime: 0,
					ctx: getTextMeasurementContext(),
				}).visualRect;
	return {
		center: {
			x: position.x + (rect.left + rect.width / 2) * scaleX,
			y: position.y + (rect.top + rect.height / 2) * scaleY,
		},
		width: Math.abs(rect.width * scaleX),
		height: Math.abs(rect.height * scaleY),
	};
}

export function coversAction({
	overlay,
	action,
}: {
	overlay: CanvasRect;
	action: CanvasRect;
}) {
	const padding = 16;
	return (
		Math.abs(overlay.center.x - action.center.x) <
			(overlay.width + action.width) / 2 + padding &&
		Math.abs(overlay.center.y - action.center.y) <
			(overlay.height + action.height) / 2 + padding
	);
}
