import type { SequenceTracks, TimelineClip, TimelineTrack } from "@/timeline";

export function findTrackInSequenceTracks({
	tracks,
	trackId,
}: {
	tracks: SequenceTracks;
	trackId: string;
}): TimelineTrack | null {
	if (tracks.main.id === trackId) {
		return tracks.main;
	}

	return (
		tracks.overlay.find((track) => track.id === trackId) ??
		tracks.audio.find((track) => track.id === trackId) ??
		null
	);
}

export function updateTrackInSequenceTracks({
	tracks,
	trackId,
	update,
}: {
	tracks: SequenceTracks;
	trackId: string;
	update: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SequenceTracks {
	if (tracks.main.id === trackId) {
		return {
			...tracks,
			main: update(tracks.main),
		};
	}

	const overlayTrackIndex = tracks.overlay.findIndex((track) => track.id === trackId);
	if (overlayTrackIndex >= 0) {
		return {
			...tracks,
			overlay: tracks.overlay.map((track, index) =>
				index === overlayTrackIndex ? update(track) : track,
			),
		};
	}

	const audioTrackIndex = tracks.audio.findIndex((track) => track.id === trackId);
	if (audioTrackIndex >= 0) {
		return {
			...tracks,
			audio: tracks.audio.map((track, index) =>
				index === audioTrackIndex ? update(track) : track,
			),
		};
	}

	return tracks;
}

function updateClipInTrack<TTrack extends TimelineTrack>({
	track,
	clipId,
	update,
	clipPredicate,
}: {
	track: TTrack;
	clipId: string;
	update: (clip: TimelineClip) => TimelineClip;
	clipPredicate?: (clip: TimelineClip) => boolean;
}): TTrack {
	const nextClips = track.clips.map((clip) => {
		if (clip.id !== clipId) {
			return clip;
		}
		if (clipPredicate && !clipPredicate(clip)) {
			return clip;
		}
		return update(clip);
	});

	return {
		...track,
		clips: nextClips,
	} as TTrack;
}

export function updateClipInSequenceTracks({
	tracks,
	trackId,
	clipId,
	update,
	clipPredicate,
}: {
	tracks: SequenceTracks;
	trackId: string;
	clipId: string;
	update: (clip: TimelineClip) => TimelineClip;
	clipPredicate?: (clip: TimelineClip) => boolean;
}): SequenceTracks {
	if (tracks.main.id === trackId) {
		return {
			...tracks,
			main: updateClipInTrack({
				track: tracks.main,
				clipId,
				update,
				clipPredicate,
			}),
		};
	}

	const overlayTrackIndex = tracks.overlay.findIndex((track) => track.id === trackId);
	if (overlayTrackIndex >= 0) {
		return {
			...tracks,
			overlay: tracks.overlay.map((track, index) =>
				index === overlayTrackIndex
					? updateClipInTrack({
							track,
							clipId,
							update,
							clipPredicate,
						})
					: track,
			),
		};
	}

	const audioTrackIndex = tracks.audio.findIndex((track) => track.id === trackId);
	if (audioTrackIndex >= 0) {
		return {
			...tracks,
			audio: tracks.audio.map((track, index) =>
				index === audioTrackIndex
					? updateClipInTrack({
							track,
							clipId,
							update,
							clipPredicate,
						})
					: track,
			),
		};
	}

	return tracks;
}
