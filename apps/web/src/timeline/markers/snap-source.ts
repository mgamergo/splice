import type { Marker } from "@/timeline";
import type { SnapPoint } from "@/timeline/snapping";
import type { MediaTime } from "@/wasm";

export function getMarkerSnapPoints({
	markers,
	excludeMarkerTime,
}: {
	markers: Marker[];
	excludeMarkerTime?: MediaTime;
}): SnapPoint[] {
	return markers.flatMap((marker) => {
		if (excludeMarkerTime != null && marker.time === excludeMarkerTime) {
			return [];
		}

		return [
			{ time: marker.time, type: "marker" satisfies SnapPoint["type"] },
		];
	});
}
