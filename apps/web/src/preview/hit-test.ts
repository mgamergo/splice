import type { ClipWithBounds } from "./clip-bounds";
import type { ClipRef } from "@/timeline/types";

function pointInRotatedRect({
	px,
	py,
	cx,
	cy,
	width,
	height,
	rotation,
}: {
	px: number;
	py: number;
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
}): boolean {
	const angleRad = (rotation * Math.PI) / 180;
	const cos = Math.cos(-angleRad);
	const sin = Math.sin(-angleRad);
	const dx = px - cx;
	const dy = py - cy;
	const localX = dx * cos - dy * sin;
	const localY = dx * sin + dy * cos;
	const halfW = Math.abs(width) / 2;
	const halfH = Math.abs(height) / 2;
	return (
		localX >= -halfW && localX <= halfW && localY >= -halfH && localY <= halfH
	);
}

export function getHitClips({
	canvasX,
	canvasY,
	clipsWithBounds,
}: {
	canvasX: number;
	canvasY: number;
	clipsWithBounds: ClipWithBounds[];
}): ClipWithBounds[] {
	const hits: ClipWithBounds[] = [];

	for (let i = clipsWithBounds.length - 1; i >= 0; i--) {
		const { bounds } = clipsWithBounds[i];
		if (
			pointInRotatedRect({
				px: canvasX,
				py: canvasY,
				cx: bounds.cx,
				cy: bounds.cy,
				width: bounds.width,
				height: bounds.height,
				rotation: bounds.rotation,
			})
		) {
			hits.push(clipsWithBounds[i]);
		}
	}

	return hits;
}

export function hitTest({
	canvasX,
	canvasY,
	clipsWithBounds,
}: {
	canvasX: number;
	canvasY: number;
	clipsWithBounds: ClipWithBounds[];
}): ClipWithBounds | null {
	return (
		getHitClips({
			canvasX,
			canvasY,
			clipsWithBounds,
		})[0] ?? null
	);
}

export function resolvePreferredHit({
	hits,
	preferredClips,
}: {
	hits: ClipWithBounds[];
	preferredClips: ClipRef[];
}): ClipWithBounds | null {
	if (preferredClips.length === 0) return null;

	return (
		hits.find((hit) =>
			preferredClips.some(
				(preferredClip) =>
					preferredClip.trackId === hit.trackId &&
					preferredClip.clipId === hit.clipId,
			),
		) ?? null
	);
}
