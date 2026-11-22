import type { MouseEvent as ReactMouseEvent } from "react";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTime,
	minMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
} from "@/wasm";
import {
	computeGroupResize,
	type GroupResizeMember,
	type GroupResizeResult,
	type GroupResizeUpdate,
	type ResizeSide,
} from "@/timeline/group-resize";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/timeline/snapping";
import { getClipEdgeSnapPoints } from "@/timeline/clip-snap-source";
import { getPlayheadSnapPoints } from "@/timeline/playhead-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import {
	isRetimableClip,
	type SequenceTracks,
	type TimelineClip,
	type TimelineTrack,
} from "@/timeline";
import type { ClipRef } from "@/timeline/types";
import type { FrameRate } from "opencut-wasm";

// --- Session ---

interface ResizeSession {
	kind: "active";
	side: ResizeSide;
	startX: number;
	fps: FrameRate;
	members: GroupResizeMember[];
	result: GroupResizeResult | null;
}

type Session = { kind: "idle" } | ResizeSession;

// --- Config ---

export interface ResizeConfig {
	zoomLevel: number;
	snappingEnabled: boolean;
	isShiftHeld: () => boolean;
	getSequenceTracks: () => SequenceTracks;
	getCurrentPlayheadTime: () => MediaTime;
	getActiveProjectFps: () => FrameRate | null;
	selectedClips: ClipRef[];
	discardPreview: () => void;
	previewClips: (updates: GroupResizeUpdate[]) => void;
	commitClips: (updates: GroupResizeUpdate[]) => void;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

export interface ResizeConfigRef {
	readonly current: ResizeConfig;
}

// --- Pure helpers ---

export function buildResizeMembers({
	tracks,
	selectedClips,
}: {
	tracks: SequenceTracks;
	selectedClips: ClipRef[];
}): GroupResizeMember[] {
	const selectedClipIds = new Set(
		selectedClips.map((el) => el.clipId),
	);
	const trackMap = new Map(
		[...tracks.overlay, tracks.main, ...tracks.audio].map((track) => [
			track.id,
			track,
		]),
	);

	return selectedClips.flatMap(({ trackId, clipId }) => {
		const track = trackMap.get(trackId);
		const clip = track?.clips.find((el) => el.id === clipId);
		if (!track || !clip) return [];

		const otherClips = track.clips.filter(
			(el) => !selectedClipIds.has(el.id),
		);
		const leftNeighborBound = otherClips
			.filter(
				(el) =>
					addMediaTime({ a: el.startTime, b: el.duration }) <=
					clip.startTime,
			)
			.reduce<MediaTime | null>((bound, el) => {
				const clipEnd = addMediaTime({
					a: el.startTime,
					b: el.duration,
				});
				return bound === null
					? clipEnd
					: maxMediaTime({ a: bound, b: clipEnd });
			}, null);
		const rightNeighborBound = otherClips
			.filter(
				(el) =>
					el.startTime >= addMediaTime({ a: clip.startTime, b: clip.duration }),
			)
			.reduce<MediaTime | null>(
				(bound, el) =>
					bound === null
						? el.startTime
						: minMediaTime({ a: bound, b: el.startTime }),
				null,
			);

		return [
			{
				trackId,
				clipId,
				startTime: clip.startTime,
				duration: clip.duration,
				trimStart: clip.trimStart,
				trimEnd: clip.trimEnd,
				sourceDuration: clip.sourceDuration,
				retime: isRetimableClip(clip) ? clip.retime : undefined,
				leftNeighborBound,
				rightNeighborBound,
			},
		];
	});
}

function hasResizeChanges({
	members,
	result,
}: {
	members: GroupResizeMember[];
	result: GroupResizeResult;
}): boolean {
	return result.updates.some((update) => {
		const member = members.find((m) => m.clipId === update.clipId);
		return (
			member?.trimStart !== update.patch.trimStart ||
			member?.trimEnd !== update.patch.trimEnd ||
			member?.startTime !== update.patch.startTime ||
			member?.duration !== update.patch.duration
		);
	});
}

// --- Controller ---

export class ResizeController {
	private session: Session = { kind: "idle" };
	private readonly subscribers = new Set<() => void>();
	private readonly configRef: ResizeConfigRef;

	constructor(deps: { configRef: ResizeConfigRef }) {
		this.configRef = deps.configRef;
		this.onResizeStart = this.onResizeStart.bind(this);
		this.handleMouseMove = this.handleMouseMove.bind(this);
		this.handleMouseUp = this.handleMouseUp.bind(this);
	}

	private get config(): ResizeConfig {
		return this.configRef.current;
	}

	get isResizing(): boolean {
		return this.session.kind === "active";
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	cancel(): void {
		this.config.discardPreview();
		this.finishSession();
	}

	destroy(): void {
		this.deactivate();
		this.subscribers.clear();
	}

	onResizeStart({
		event,
		clip,
		track,
		side,
	}: {
		event: ReactMouseEvent;
		clip: TimelineClip;
		track: TimelineTrack;
		side: ResizeSide;
	}): void {
		event.stopPropagation();
		event.preventDefault();

		// UI should prevent this, but be explicit: a new resize start
		// means the previous one is abandoned, not silently replaced.
		if (this.session.kind === "active") this.cancel();

		const fps = this.config.getActiveProjectFps();
		if (!fps) return;

		const ref = { trackId: track.id, clipId: clip.id };
		const activeSelection = this.config.selectedClips.some(
			(el) => el.trackId === track.id && el.clipId === clip.id,
		)
			? this.config.selectedClips
			: [ref];

		const members = buildResizeMembers({
			tracks: this.config.getSequenceTracks(),
			selectedClips: activeSelection,
		});
		if (members.length === 0) return;

		this.config.discardPreview();

		this.session = {
			kind: "active",
			side,
			startX: event.clientX,
			fps,
			members,
			result: null,
		};
		this.activate();
		this.notify();
	}

	private activate(): void {
		document.addEventListener("mousemove", this.handleMouseMove);
		document.addEventListener("mouseup", this.handleMouseUp);
	}

	private deactivate(): void {
		document.removeEventListener("mousemove", this.handleMouseMove);
		document.removeEventListener("mouseup", this.handleMouseUp);
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	private finishSession(): void {
		this.session = { kind: "idle" };
		this.deactivate();
		this.config.onSnapPointChange?.(null);
		this.notify();
	}

	private snappedDelta({
		session,
		rawDeltaTime,
	}: {
		session: ResizeSession;
		rawDeltaTime: MediaTime;
	}): MediaTime {
		const { snappingEnabled, isShiftHeld, zoomLevel } = this.config;

		if (!snappingEnabled || isShiftHeld()) {
			this.config.onSnapPointChange?.(null);
			return rawDeltaTime;
		}

		const tracks = this.config.getSequenceTracks();
		const playheadTime = this.config.getCurrentPlayheadTime();
		const excludeClipIds = new Set(session.members.map((m) => m.clipId));

		const snapPoints = buildTimelineSnapPoints({
			sources: [
				() => getClipEdgeSnapPoints({ tracks, excludeClipIds }),
				() => getPlayheadSnapPoints({ playheadTime }),
				() =>
					getAnimationKeyframeSnapPointsForTimeline({
						tracks,
						excludeClipIds,
					}),
			],
		});
		const maxSnapDistance = getTimelineSnapThresholdInTicks({ zoomLevel });

		let closestSnapPoint: SnapPoint | null = null;
		let closestSnapDistance = Infinity;
		let deltaTime = rawDeltaTime;

		for (const member of session.members) {
			const baseEdgeTime =
				session.side === "left"
					? member.startTime
					: addMediaTime({ a: member.startTime, b: member.duration });
			const snapResult = resolveTimelineSnap({
				targetTime: addMediaTime({ a: baseEdgeTime, b: rawDeltaTime }),
				snapPoints,
				maxSnapDistance,
			});
			if (
				snapResult.snapPoint &&
				snapResult.snapDistance < closestSnapDistance
			) {
				closestSnapDistance = snapResult.snapDistance;
				closestSnapPoint = snapResult.snapPoint;
				deltaTime = subMediaTime({ a: snapResult.snappedTime, b: baseEdgeTime });
			}
		}

		this.config.onSnapPointChange?.(closestSnapPoint);
		return deltaTime;
	}

	private handleMouseMove({ clientX }: MouseEvent): void {
		if (this.session.kind !== "active") return;
		const session = this.session;

		const rawDeltaTime = mediaTime({
			ticks: Math.round(
				((clientX - session.startX) /
					(BASE_TIMELINE_PIXELS_PER_SECOND * this.config.zoomLevel)) *
					TICKS_PER_SECOND,
			),
		});
		const deltaTime = this.snappedDelta({ session, rawDeltaTime });
		const result = computeGroupResize({
			members: session.members,
			side: session.side,
			deltaTime,
			fps: session.fps,
		});

		session.result = result;
		this.config.previewClips(result.updates);
	}

	private handleMouseUp(): void {
		if (this.session.kind !== "active") return;
		const session = this.session;

		this.config.discardPreview();

		if (
			session.result &&
			hasResizeChanges({ members: session.members, result: session.result })
		) {
			this.config.commitClips(session.result.updates);
		}

		this.finishSession();
	}
}
