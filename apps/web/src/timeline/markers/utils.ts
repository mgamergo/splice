import type { Marker } from "@/timeline";
import type { FrameRate } from "opencut-wasm";
import {
	addMediaTime,
	minMediaTime,
	maxMediaTime,
	roundFrameTime,
	type MediaTime,
} from "@/wasm";

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
	return findOrdinaryMarkerIndex({ markers, time: frameTime }) !== -1;
}

function findOrdinaryMarkerIndex({
	markers,
	time,
}: {
	markers: Marker[];
	time: MediaTime;
}) {
	return markers.findIndex((marker) => !marker.data && marker.time === time);
}

export function toggleMarkerInArray({
	markers,
	frameTime,
}: {
	markers: Marker[];
	frameTime: MediaTime;
}): Marker[] {
	const markerIndex = findOrdinaryMarkerIndex({ markers, time: frameTime });

	if (markerIndex !== -1) {
		return markers.filter((_, index) => index !== markerIndex);
	}

	const newMarkers = [...markers, { time: frameTime }];
	return newMarkers.slice().sort((a, b) => a.time - b.time);
}

export function removeMarkerFromArray({
	markers,
	time,
}: {
	markers: Marker[];
	time: MediaTime;
}): Marker[] {
	const index = findOrdinaryMarkerIndex({ markers, time });
	return index === -1
		? markers
		: markers.filter((_, position) => position !== index);
}

export function updateMarkerInArray({
	markers,
	time,
	updates,
}: {
	markers: Marker[];
	time: MediaTime;
	updates: Partial<Pick<Marker, "note" | "color" | "duration">>;
}): Marker[] {
	const index = findOrdinaryMarkerIndex({ markers, time });
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
	markerId,
}: {
	markers: Marker[];
	fromTime: MediaTime;
	toTime: MediaTime;
	markerId?: string;
}): Marker[] {
	const index = markers.findIndex((marker) =>
		markerId ? marker.id === markerId : !marker.id && marker.time === fromTime,
	);
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

export function clampMarkerDragTime({
	time,
	duration,
	markerTime,
}: {
	time: MediaTime;
	duration: MediaTime;
	markerTime: MediaTime;
}): MediaTime {
	return minMediaTime({
		a: time,
		b: maxMediaTime({ a: duration, b: markerTime }),
	});
}
