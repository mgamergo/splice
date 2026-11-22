import type { Marker } from "@/timeline";
import type { FrameRate } from "opencut-wasm";
import { addMediaTime, roundFrameTime, type MediaTime } from "@/wasm";

function markerTimeEqual({
	markerTime,
	frameTime,
}: {
	markerTime: MediaTime;
	frameTime: MediaTime;
}): boolean {
	return markerTime === frameTime;
}

export function findMarkerIndex({
	markers,
	frameTime,
}: {
	markers: Marker[];
	frameTime: MediaTime;
}): number {
	return markers.findIndex((marker) =>
		markerTimeEqual({ markerTime: marker.time, frameTime }),
	);
}

export function isMarkerAtTime({
	markers,
	frameTime,
}: {
	markers: Marker[];
	frameTime: MediaTime;
}): boolean {
	return markers.some((marker) =>
		markerTimeEqual({ markerTime: marker.time, frameTime }),
	);
}

export function toggleMarkerInArray({
	markers,
	frameTime,
}: {
	markers: Marker[];
	frameTime: MediaTime;
}): Marker[] {
	const markerIndex = findMarkerIndex({ markers, frameTime });

	if (markerIndex !== -1) {
		return markers.filter((_, index) => index !== markerIndex);
	}

	const newMarkers = [...markers, { time: frameTime }];
	return newMarkers.slice().sort((a, b) => a.time - b.time);
}

export function removeMarkerFromArray({
	markers,
	frameTime,
}: {
	markers: Marker[];
	frameTime: MediaTime;
}): Marker[] {
	return markers.filter(
		(marker) =>
			!markerTimeEqual({ markerTime: marker.time, frameTime }),
	);
}

export function updateMarkerInArray({
	markers,
	frameTime,
	updates,
}: {
	markers: Marker[];
	frameTime: MediaTime;
	updates: Partial<Omit<Marker, "time">>;
}): Marker[] {
	const index = findMarkerIndex({ markers, frameTime });
	if (index === -1) {
		return markers;
	}

	const updated = { ...markers[index], ...updates };
	const result = [...markers];
	result[index] = updated;
	return result;
}

export function moveMarkerInArray({
	markers,
	fromTime,
	toTime,
}: {
	markers: Marker[];
	fromTime: MediaTime;
	toTime: MediaTime;
}): Marker[] {
	const index = findMarkerIndex({ markers, frameTime: fromTime });
	if (index === -1) {
		return markers;
	}

	const updated = { ...markers[index], time: toTime };
	const result = [...markers];
	result[index] = updated;
	return result.slice().sort((a, b) => a.time - b.time);
}

export function getFrameTime({
	time,
	fps,
}: {
	time: MediaTime;
	fps: FrameRate;
}): MediaTime {
	return roundFrameTime({ time, fps });
}

export function getMarkerAtTime({
	markers,
	frameTime,
}: {
	markers: Marker[];
	frameTime: MediaTime;
}): Marker | null {
	const index = findMarkerIndex({ markers, frameTime });
	return index === -1 ? null : markers[index];
}

export function getMarkersActiveAtTime({
	markers,
	time,
}: {
	markers: Marker[];
	time: MediaTime;
}): Marker[] {
	return markers.filter((marker) => {
		const start = marker.time;
		const end =
			marker.duration != null && marker.duration > 0
				? addMediaTime({ a: start, b: marker.duration })
				: start;
		return time >= start && time <= end;
	});
}
