import type { Marker } from "@/timeline";
import {
	EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
	type PreviewOverlayDefinition,
	type PreviewOverlaySourceResult,
} from "@/preview/overlays";
import { getMarkersActiveAtTime } from "./utils";
import type { MediaTime } from "@/wasm";

export const markerNotesPreviewOverlay: PreviewOverlayDefinition = {
	id: "marker-notes",
	label: "Show marker notes",
	defaultVisible: true,
};

function MarkerNotesOverlay({
	markers,
}: {
	markers: Array<{ time: MediaTime; note: string; color?: string }>;
}) {
	return (
		<div className="flex flex-col gap-1.5" aria-live="polite">
			{markers.map((marker) => (
				<div
					key={marker.time}
					className="flex max-w-[min(200px,50vw)] px-2.5 py-1.5 text-left text-white text-xs shadow-md backdrop-blur-sm"
					style={{
						backgroundColor: "rgb(0 0 0 / 0.5)",
						borderLeft: marker.color
							? `3px solid ${marker.color}`
							: "3px solid var(--primary)",
					}}
				>
					{marker.note}
				</div>
			))}
		</div>
	);
}

export function getMarkerPreviewOverlaySource({
	markers,
	time,
	isVisible,
}: {
	markers: Marker[];
	time: MediaTime;
	isVisible: boolean;
}): PreviewOverlaySourceResult {
	const markersWithNotes = getMarkersActiveAtTime({
		markers,
		time,
	}).flatMap((marker) => {
		if (marker.note == null || marker.note.trim() === "") {
			return [];
		}

		return [
			{
				time: marker.time,
				note: marker.note,
				color: marker.color,
			},
		];
	});

	if (!isVisible || markersWithNotes.length === 0) {
		return {
			...EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
			definitions: [markerNotesPreviewOverlay],
		};
	}

	return {
		definitions: [markerNotesPreviewOverlay],
		instances: [
			{
				id: markerNotesPreviewOverlay.id,
				mount: { kind: "hud", anchor: "top-left", order: 0 },
				plane: "over-interaction",
				pointerEvents: "none",
				render: () => <MarkerNotesOverlay markers={markersWithNotes} />,
			},
		],
	};
}
