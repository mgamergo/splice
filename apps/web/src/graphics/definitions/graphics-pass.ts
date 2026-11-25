import type { ParamDefinition } from "@/params";
import { applyAlignedStroke } from "../stroke";
import type { GraphicDefinition } from "../types";

interface HighlightParams {
	stroke: string;
	strokeWidth: number;
	aspect: number;
	cornerRadius: number;
}

const HIGHLIGHT_PARAMS: ParamDefinition<keyof HighlightParams & string>[] = [
	{
		key: "stroke",
		label: "Color",
		type: "color",
		default: "#ffd60a",
		group: "stroke",
	},
	{
		key: "strokeWidth",
		label: "Width",
		type: "number",
		default: 10,
		min: 1,
		max: 64,
		step: 1,
		shortLabel: "W",
		group: "stroke",
	},
	{
		key: "aspect",
		label: "Aspect",
		type: "number",
		default: 1,
		min: 0.05,
		max: 20,
		step: 0.01,
		shortLabel: "A",
	},
	{
		key: "cornerRadius",
		label: "Corner radius",
		type: "number",
		default: 12,
		min: 0,
		max: 50,
		step: 1,
		shortLabel: "R",
	},
];

/**
 * The box a highlight draws around a screen detail. The box keeps its aspect
 * inside a square source, so scaling the clip evenly keeps the stroke even.
 */
export function highlightBoxSize({
	aspect,
	size,
}: {
	aspect: number;
	size: number;
}): { width: number; height: number } {
	return aspect >= 1
		? { width: size, height: size / aspect }
		: { width: size * aspect, height: size };
}

export const highlightGraphicDefinition: GraphicDefinition = {
	id: "highlight",
	name: "Highlight",
	keywords: ["highlight", "box", "outline", "callout"],
	params: HIGHLIGHT_PARAMS,
	render({ ctx, params, width, height }) {
		const stroke = String(params.stroke ?? "#ffd60a");
		const strokeWidth = Math.max(1, Number(params.strokeWidth ?? 10));
		const aspect = Math.max(0.05, Number(params.aspect ?? 1));
		const box = highlightBoxSize({
			aspect,
			size: Math.min(width, height) - strokeWidth,
		});
		const radius = Math.min(
			Math.max(0, Number(params.cornerRadius ?? 0)),
			Math.min(box.width, box.height) / 2,
		);

		ctx.clearRect(0, 0, width, height);
		const path = new Path2D();
		path.roundRect(
			(width - box.width) / 2,
			(height - box.height) / 2,
			box.width,
			box.height,
			radius,
		);
		applyAlignedStroke({
			ctx,
			path,
			strokeWidth,
			strokeAlign: "center",
			strokeColor: stroke,
		});
	},
};

/**
 * A zoom's handle on the timeline. It draws nothing: its timing, position and
 * size describe the part of the frame the zoom fills the screen with.
 */
export const zoomGraphicDefinition: GraphicDefinition = {
	id: "zoom",
	name: "Zoom",
	keywords: ["zoom", "crop", "magnify"],
	params: [],
	render({ ctx, width, height }) {
		ctx.clearRect(0, 0, width, height);
	},
};
