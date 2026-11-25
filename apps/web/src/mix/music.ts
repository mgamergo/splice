import {
	DEFAULT_DUCK_DB,
	type MixOverride,
	MUSIC_TRACK_NAME,
	type MusicSettings,
} from "@splice/bridge/mix";
import type { CaptionsRequest } from "@splice/bridge/ops";
import { mapWordsToTimeline } from "@/agent/captions";
import type { ScalarAnimationKey } from "@/animation/types";
import type { ProjectItem } from "@/media/types";
import {
	buildClipFromMedia,
	canClipHaveAudio,
	canTrackHaveAudio,
	doesClipHaveEnabledAudio,
	hasMediaId,
} from "@/timeline";
import { isClipMuted } from "@/timeline/audio-state";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import type {
	AudioTrack,
	SequenceTracks,
	TSequence,
	UploadAudioClip,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export const MUSIC_DEFAULTS = {
	duckDb: DEFAULT_DUCK_DB,
	fadeInSeconds: 2,
	fadeOutSeconds: 3,
	holdPauseSeconds: 1.5,
} as const;

/** Music starts dipping this long before speech… */
const FALL_SECONDS = 0.4;
/** …is fully down this long before the first word… */
const LEAD_SECONDS = 0.15;
/** …and rises this slowly once a quiet passage begins. */
const RISE_SECONDS = 2;
/** A short dip where the track loops, so the join doesn't click. */
const LOOP_SEAM_SECONDS = 0.03;
/** Fades are drawn with a point this often, since the volume floor bends them. */
const FADE_STEP_SECONDS = 0.25;

export interface Passage {
	/** Sequence seconds. */
	start: number;
	end: number;
}

export class MusicError extends Error {}

export function isMusicTrack({
	track,
	music,
}: {
	track: { id: string };
	music: MusicSettings | undefined;
}): boolean {
	return track.id === music?.trackId;
}

/** The tracks without the music, so music never ducks under itself or sets its own length. */
function withoutMusic({
	tracks,
	music,
}: {
	tracks: SequenceTracks;
	music: MusicSettings | undefined;
}): SequenceTracks {
	return {
		...tracks,
		audio: tracks.audio.filter((track) => !isMusicTrack({ track, music })),
	};
}

/** Where the sequence's content ends, in seconds, not counting the music. */
export function contentEndSeconds({
	tracks,
	music,
}: {
	tracks: SequenceTracks;
	music: MusicSettings | undefined;
}): number {
	const { main, overlay, audio } = withoutMusic({ tracks, music });
	let end = 0;
	for (const track of [main, ...overlay, ...audio])
		for (const clip of track.clips)
			end = Math.max(
				end,
				mediaTimeToSeconds({
					time: addMediaTime({ a: clip.startTime, b: clip.duration }),
				}),
			);
	return end;
}

/**
 * Where the narration speaks, in sequence seconds: the transcript words heard
 * in the cut. A recording without a transcript counts as speaking wherever it
 * plays, so music never rises over narration nobody has transcribed.
 */
export function speechPassages({
	tracks,
	projectItems,
	sources,
	music,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	sources: CaptionsRequest["sources"];
	music: MusicSettings | undefined;
}): { passages: Passage[]; untranscribedItemIds: string[] } {
	const content = withoutMusic({ tracks, music });
	const passages: Passage[] = mapWordsToTimeline({
		tracks: content,
		sources,
	}).map(({ start, end }) => ({ start, end }));
	const transcribed = new Set(
		sources
			.filter(({ words }) => words.length > 0)
			.map(({ projectItemId }) => projectItemId),
	);
	const items = new Map(projectItems.map((item) => [item.id, item]));
	const untranscribed = new Set<string>();
	for (const track of [content.main, ...content.overlay, ...content.audio]) {
		if (canTrackHaveAudio(track) && track.muted) continue;
		for (const clip of track.clips) {
			if (!canClipHaveAudio(clip) || !hasMediaId(clip)) continue;
			if (isClipMuted({ clip }) || transcribed.has(clip.mediaId)) continue;
			const item = items.get(clip.mediaId);
			if (!item || !doesClipHaveEnabledAudio({ clip, projectItem: item }))
				continue;
			untranscribed.add(clip.mediaId);
			const start = mediaTimeToSeconds({ time: clip.startTime });
			passages.push({
				start,
				end: start + mediaTimeToSeconds({ time: clip.duration }),
			});
		}
	}
	return {
		passages: passages.sort((a, b) => a.start - b.start),
		untranscribedItemIds: [...untranscribed],
	};
}

/**
 * The passages music stays ducked through: speech and the creator's
 * overrides, joined across pauses shorter than `holdPauseSeconds`.
 */
export function duckedPassages({
	speech,
	overrides,
	holdPauseSeconds,
}: {
	speech: Passage[];
	overrides: MixOverride[];
	holdPauseSeconds: number;
}): Passage[] {
	const all = [
		...speech,
		...overrides.map(({ start, end }) => ({ start, end })),
	]
		.filter(({ start, end }) => end > start)
		.sort((a, b) => a.start - b.start);
	const merged: Passage[] = [];
	for (const passage of all) {
		const last = merged.at(-1);
		if (last && passage.start - last.end <= holdPauseSeconds)
			last.end = Math.max(last.end, passage.end);
		else merged.push({ ...passage });
	}
	return merged;
}

export interface EnvelopePoint {
	/** Sequence seconds. */
	time: number;
	/** Music clip volume in dB. */
	db: number;
}

/** How far ducking lowers the music at `time`, in dB (0 or below). */
function duckingAt({
	passages,
	duckDb,
	time,
}: {
	passages: Passage[];
	duckDb: number;
	time: number;
}): number {
	// Only the passage immediately before or after this point can affect it.
	let low = 0;
	let high = passages.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (passages[middle].start - LEAD_SECONDS <= time) low = middle + 1;
		else high = middle;
	}
	const previous = passages[low - 1];
	const next = passages[low];
	const depth = -duckDb;
	return Math.min(
		0,
		previous
			? duckDb + (Math.max(0, time - previous.end) * depth) / RISE_SECONDS
			: 0,
		next
			? duckDb + ((next.start - LEAD_SECONDS - time) * depth) / FALL_SECONDS
			: 0,
	);
}

/** How far the fades lower the music at `time`, in dB, down to the volume floor. */
function fadeAt({
	time,
	length,
	fadeInSeconds,
	fadeOutSeconds,
	levelDb,
}: {
	time: number;
	length: number;
	fadeInSeconds: number;
	fadeOutSeconds: number;
	levelDb: number;
}): number {
	const floor = VOLUME_DB_MIN - levelDb;
	let offset = 0;
	if (fadeInSeconds > 0 && time < fadeInSeconds)
		offset = Math.min(offset, floor * (1 - time / fadeInSeconds));
	const fadeOutStart = length - fadeOutSeconds;
	if (fadeOutSeconds > 0 && time > fadeOutStart)
		offset = Math.min(
			offset,
			floor * Math.min(1, (time - fadeOutStart) / fadeOutSeconds),
		);
	return offset;
}

/**
 * The music's volume across the sequence, as points joined by straight lines
 * in dB: `levelDb` in quiet passages, `duckDb` lower under speech, with a
 * quick dip ahead of each spoken passage, a gentle rise after it, and fades
 * at both ends. Every corner of that shape is a point, so playing the points
 * back as linear keyframes reproduces it.
 */
export function musicEnvelope({
	passages,
	settings: { levelDb, duckDb, fadeInSeconds, fadeOutSeconds },
	length,
}: {
	passages: Passage[];
	settings: Pick<
		MusicSettings,
		"levelDb" | "duckDb" | "fadeInSeconds" | "fadeOutSeconds"
	>;
	length: number;
}): EnvelopePoint[] {
	if (length <= 0) return [];
	const fadeIn = Math.min(fadeInSeconds, length / 2);
	const fadeOut = Math.min(fadeOutSeconds, length / 2);
	const times = new Set<number>([0, length, fadeIn, length - fadeOut]);
	for (let time = 0; time < fadeIn; time += FADE_STEP_SECONDS) times.add(time);
	for (let time = length; time > length - fadeOut; time -= FADE_STEP_SECONDS)
		times.add(time);
	const depth = -duckDb;
	passages.forEach(({ start, end }, index) => {
		const down = start - LEAD_SECONDS;
		times.add(down - FALL_SECONDS);
		times.add(down);
		times.add(end);
		times.add(end + RISE_SECONDS);
		// Where a short quiet passage's rise meets the next dip.
		const next = passages[index + 1];
		if (next && depth > 0) {
			const nextDown = next.start - LEAD_SECONDS;
			times.add(
				(end * FALL_SECONDS + nextDown * RISE_SECONDS) /
					(RISE_SECONDS + FALL_SECONDS),
			);
		}
	});
	const round = (value: number) => Math.round(value * 100) / 100;
	const points = [...times]
		.filter((time) => time >= 0 && time <= length)
		.sort((a, b) => a - b)
		.map((time) => ({
			time,
			db: round(
				Math.min(
					VOLUME_DB_MAX,
					Math.max(
						VOLUME_DB_MIN,
						levelDb +
							duckingAt({ passages, duckDb, time }) +
							fadeAt({
								time,
								length,
								fadeInSeconds: fadeIn,
								fadeOutSeconds: fadeOut,
								levelDb,
							}),
					),
				),
			),
		}));
	// Points in the middle of a straight run add nothing.
	return points.filter((point, index) => {
		const before = points[index - 1];
		const after = points[index + 1];
		if (!before || !after) return true;
		const expected =
			before.db +
			((after.db - before.db) * (point.time - before.time)) /
				(after.time - before.time);
		return Math.abs(expected - point.db) > 0.01;
	});
}

/** The envelope's volume at `time`. */
export function envelopeAt({
	points,
	time,
}: {
	points: EnvelopePoint[];
	time: number;
}): number {
	if (points.length === 0) return 0;
	if (time <= points[0].time) return points[0].db;
	let low = 1;
	let high = points.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (points[middle].time < time) low = middle + 1;
		else high = middle;
	}
	if (low === points.length) return points[low - 1].db;
	const before = points[low - 1];
	const after = points[low];
	return (
		before.db +
		((after.db - before.db) * (time - before.time)) / (after.time - before.time)
	);
}

/**
 * The music's clips, back to back from the start, looping the track until
 * the sequence ends, with volume keyframes from `envelope`. Each loop join
 * dips briefly so it doesn't click.
 */
function fitMusicClips({
	item,
	length,
	envelope,
	levelDb,
}: {
	item: Pick<ProjectItem, "id" | "name" | "duration">;
	length: number;
	envelope: EnvelopePoint[];
	levelDb: number;
}): UploadAudioClip[] {
	const sourceDuration = mediaTimeFromSeconds({ seconds: item.duration ?? 0 });
	if (sourceDuration <= 0)
		throw new MusicError(`${item.name} has no known duration to fit.`);
	const endTime = mediaTimeFromSeconds({ seconds: length });
	if (Math.ceil(endTime / sourceDuration) > 10000)
		throw new MusicError(
			"This file is too short to loop across the sequence. Choose a longer music track.",
		);
	const clips: UploadAudioClip[] = [];
	let envelopeIndex = 0;
	for (let startTick = 0; startTick < endTime; startTick += sourceDuration) {
		const startTime = roundMediaTime({ time: startTick });
		const endTick = Math.min(startTick + sourceDuration, endTime);
		const duration = roundMediaTime({ time: endTick - startTick });
		const start = mediaTimeToSeconds({ time: startTime });
		const end = mediaTimeToSeconds({ time: roundMediaTime({ time: endTick }) });
		const loopsIn = startTick > 0;
		const loopsOut = endTick < endTime;
		const seam = Math.min(LOOP_SEAM_SECONDS, (end - start) / 4);
		const insideStart = start + (loopsIn ? seam : 0);
		const insideEnd = end - (loopsOut ? seam : 0);
		while (
			envelopeIndex < envelope.length &&
			envelope[envelopeIndex].time <= insideStart
		)
			envelopeIndex++;
		const first = envelopeIndex;
		while (
			envelopeIndex < envelope.length &&
			envelope[envelopeIndex].time < insideEnd
		)
			envelopeIndex++;
		const inside = envelope.slice(first, envelopeIndex);
		const points: EnvelopePoint[] = [
			...(loopsIn
				? [
						{ time: start, db: VOLUME_DB_MIN },
						{
							time: start + seam,
							db: envelopeAt({ points: envelope, time: start + seam }),
						},
					]
				: [{ time: start, db: envelopeAt({ points: envelope, time: start }) }]),
			...inside,
			...(loopsOut
				? [
						{
							time: end - seam,
							db: envelopeAt({ points: envelope, time: end - seam }),
						},
						{ time: end, db: VOLUME_DB_MIN },
					]
				: [{ time: end, db: envelopeAt({ points: envelope, time: end }) }]),
		];
		const clip = buildClipFromMedia({
			mediaId: item.id,
			mediaType: "audio",
			name: item.name,
			duration,
			startTime,
		});
		if (clip.type !== "audio" || clip.sourceType !== "upload")
			throw new MusicError(`${item.name} isn't an audio file.`);
		clips.push({
			...clip,
			id: generateUUID(),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: roundMediaTime({ time: sourceDuration - duration }),
			sourceDuration,
			params: { ...clip.params, volume: levelDb },
			animations: {
				volume: { keys: volumeKeys({ points, clipStart: start }) },
			},
		});
	}
	return clips;
}

function volumeKeys({
	points,
	clipStart,
	generated = false,
}: {
	points: EnvelopePoint[];
	clipStart: number;
	generated?: boolean;
}): ScalarAnimationKey[] {
	const keys: ScalarAnimationKey[] = [];
	for (const { time, db } of points) {
		const at = roundMediaTime({
			time: mediaTimeFromSeconds({ seconds: Math.max(0, time - clipStart) }),
		});
		// Two points a tick apart keep the later one.
		if (keys.at(-1)?.time === at) keys.pop();
		keys.push({
			id: generated ? String(at) : generateUUID(),
			time: at,
			value: db,
			segmentToNext: "linear",
			tangentMode: "auto",
		});
	}
	return keys;
}

/**
 * Reports the ducking passages and optionally fits new music clips with
 * fades and loop seams. A new track goes below the other audio tracks.
 */
export function withMusic({
	tracks,
	settings,
	item,
	speech,
	refit = true,
}: {
	tracks: SequenceTracks;
	settings: MusicSettings;
	refit?: boolean;
	item: Pick<ProjectItem, "id" | "name" | "duration">;
	speech: Passage[];
}): { tracks: SequenceTracks; passages: Passage[] } {
	const length = contentEndSeconds({ tracks, music: settings });
	if (length <= 0)
		throw new MusicError(
			"The sequence is empty, so there is nothing to fit music to.",
		);
	const fingerprint = musicTimingFingerprint({ tracks, music: settings });
	const passages = duckedPassages({
		speech,
		overrides: settings.overrides.filter((override) =>
			isCurrentOverride({ override, fingerprint }),
		),
		holdPauseSeconds: settings.holdPauseSeconds,
	});
	const existing = tracks.audio.find((track) =>
		isMusicTrack({ track, music: settings }),
	);
	if (!refit) return { tracks, passages };
	const envelope = musicEnvelope({ passages: [], settings, length });
	const clips = fitMusicClips({
		item,
		length,
		envelope,
		levelDb: settings.levelDb,
	});
	const track: AudioTrack = existing
		? { ...existing, clips }
		: {
				id: settings.trackId,
				name: MUSIC_TRACK_NAME,
				type: "audio",
				muted: false,
				clips,
			};
	return {
		tracks: {
			...tracks,
			audio: existing
				? tracks.audio.map((candidate) =>
						candidate.id === track.id ? track : candidate,
					)
				: [...tracks.audio, track],
		},
		passages,
	};
}

/** Identifies the timing of the non-music source clips for absolute overrides. */
export function musicTimingFingerprint({
	tracks,
	music,
}: {
	tracks: SequenceTracks;
	music: MusicSettings;
}): string {
	const content = withoutMusic({ tracks, music });
	const timings = [content.main, ...content.overlay, ...content.audio].flatMap(
		({ clips }) =>
			clips.flatMap((clip) =>
				canClipHaveAudio(clip) &&
				hasMediaId(clip) &&
				(clip.type !== "video" || clip.isSourceAudioEnabled !== false)
					? [
							JSON.stringify([
								clip.id,
								clip.mediaId,
								clip.startTime,
								clip.trimStart,
								clip.duration,
								clip.retime?.rate,
							]),
						]
					: [],
			),
	);
	return fingerprintText(timings.sort().join("\n"));
}

export function fingerprintText(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${hash.toString(16)}-${value.length.toString(16)}`;
}

export function isCurrentOverride({
	override,
	fingerprint,
}: {
	override: MixOverride;
	fingerprint: string;
}): boolean {
	return override.timelineFingerprint === fingerprint;
}

/** Derive the ducking layer from the edit being played. Creator keys stay on the clips. */
export function tracksWithMusicDucking({
	sequence,
	projectItems,
	projectSources = [],
}: {
	sequence: TSequence;
	projectItems: ProjectItem[];
	projectSources?: CaptionsRequest["sources"];
}): SequenceTracks {
	const { tracks, mix } = sequence;
	const music = mix?.music;
	if (!music) return tracks;
	const sources = new Map<string, CaptionsRequest["sources"][number]>();
	for (const source of [
		...(music.fit?.sources ?? []),
		...(sequence.captions?.sources ?? []),
		...projectSources,
	]) {
		if (source.words.length) sources.set(source.projectItemId, source);
	}
	const fingerprint = musicTimingFingerprint({ tracks, music });
	const { passages: speech } = speechPassages({
		tracks,
		projectItems,
		sources: [...sources.values()],
		music,
	});
	const passages = duckedPassages({
		speech,
		overrides: music.overrides.filter((override) =>
			isCurrentOverride({ override, fingerprint }),
		),
		holdPauseSeconds: music.holdPauseSeconds,
	});
	const length = contentEndSeconds({ tracks, music });
	const points = musicEnvelope({
		passages,
		settings: {
			levelDb: 0,
			duckDb: music.duckDb,
			fadeInSeconds: 0,
			fadeOutSeconds: 0,
		},
		length,
	});
	const firstAfter = (time: number) => {
		let low = 0;
		let high = points.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (points[middle].time <= time) low = middle + 1;
			else high = middle;
		}
		return low;
	};
	return {
		...tracks,
		audio: tracks.audio.map((track) =>
			!isMusicTrack({ track, music })
				? track
				: {
						...track,
						clips: track.clips.map((clip) => {
							const start = mediaTimeToSeconds({ time: clip.startTime });
							const end = start + mediaTimeToSeconds({ time: clip.duration });
							const keys = volumeKeys({
								points: [
									{ time: start, db: envelopeAt({ points, time: start }) },
									...points.slice(firstAfter(start), firstAfter(end)),
									{ time: end, db: envelopeAt({ points, time: end }) },
								],
								clipStart: start,
								generated: true,
							});
							return keys.some(({ value }) => value !== 0)
								? { ...clip, musicDucking: { keys } }
								: clip;
						}),
					},
		),
	};
}
