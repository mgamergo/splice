import type { SequenceTracks, TimelineTrack } from "@/timeline/types";
import { rippleShiftClips } from "./shift";

export interface RippleAdjustment {
	trackId: string;
	afterTime: number;
	shiftAmount: number;
}

export function applyRippleAdjustments({
	tracks,
	adjustments,
}: {
	tracks: SequenceTracks;
	adjustments: RippleAdjustment[];
}): SequenceTracks {
	if (adjustments.length === 0) {
		return tracks;
	}

	const adjustmentsByTrack = new Map<string, RippleAdjustment[]>();
	for (const adjustment of adjustments) {
		const trackAdjustments = adjustmentsByTrack.get(adjustment.trackId) ?? [];
		trackAdjustments.push(adjustment);
		adjustmentsByTrack.set(adjustment.trackId, trackAdjustments);
	}

	return {
		overlay: tracks.overlay.map((track) =>
			applyTrackRippleAdjustments({
				track,
				adjustments: adjustmentsByTrack.get(track.id) ?? [],
			}),
		),
		main: applyTrackRippleAdjustments({
			track: tracks.main,
			adjustments: adjustmentsByTrack.get(tracks.main.id) ?? [],
		}),
		audio: tracks.audio.map((track) =>
			applyTrackRippleAdjustments({
				track,
				adjustments: adjustmentsByTrack.get(track.id) ?? [],
			}),
		),
	};
}

function applyTrackRippleAdjustments<
	TClip extends TimelineTrack["clips"][number],
	TTrack extends TimelineTrack & { clips: TClip[] },
>({
	track,
	adjustments,
}: {
	track: TTrack;
	adjustments: RippleAdjustment[];
}): TTrack {
	if (adjustments.length === 0) {
		return track;
	}

	const sortedAdjustments = [...adjustments].sort(
		(firstAdjustment, secondAdjustment) =>
			secondAdjustment.afterTime - firstAdjustment.afterTime,
	);

	let clips: TClip[] = track.clips;
	for (const adjustment of sortedAdjustments) {
		clips = rippleShiftClips({
			clips,
			afterTime: adjustment.afterTime,
			shiftAmount: adjustment.shiftAmount,
		});
	}

	return { ...track, clips };
}
