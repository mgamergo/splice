import {
	DEFAULT_MUSIC_LEVEL_DB,
	DEFAULT_MUSIC_QUIET_LU,
	type MixLoudness,
	type MusicSettings,
	type SequenceMix,
	type UpdateMusicRequest,
} from "@splice/bridge/mix";
import {
	type CaptionsRequest,
	DEFAULT_TARGET_LUFS,
	MAX_TRUE_PEAK_DBTP,
} from "@splice/bridge/ops";
import { fetchTranscriptSources } from "@/captions/project-captions";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import type { EditorCore } from "@/core";
import { createTimelineAudioBuffer, decodeAudioRange } from "@/media/audio";
import type { ProjectItem } from "@/media/types";
import { calculateTotalDuration } from "@/timeline";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import type { SequenceTracks, TSequence } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import { type MixMeasurement, measureMix, planMixGain } from "./loudness-meter";
import {
	contentEndSeconds,
	isMusicTrack,
	MUSIC_DEFAULTS,
	MusicError,
	speechPassages,
	withMusic,
} from "./music";

/** Sample rate music is measured at; loudness doesn't depend on it. */
const MEASURE_SAMPLE_RATE = 48000;

export { MusicError } from "./music";

function findSequence({
	editor,
	sequenceId,
}: {
	editor: EditorCore;
	sequenceId: string;
}): TSequence {
	const sequence = editor.sequences
		.getSequences()
		.find(({ id }) => id === sequenceId);
	if (!sequence) throw new MusicError(`Sequence ${sequenceId} is gone.`);
	return sequence;
}

/**
 * Identifies what a sequence sounds like: every clip that can play audio,
 * with the settings that shape it. A change to picture alone keeps it, so a
 * zoom doesn't make the mix's measurement stale.
 */
export function mixFingerprint({ tracks }: { tracks: SequenceTracks }): string {
	const audible = [tracks.main, ...tracks.overlay, ...tracks.audio]
		.filter((track) => track.type === "video" || track.type === "audio")
		.map((track) => ({
			muted: "muted" in track ? track.muted : false,
			clips: track.clips.flatMap((clip) =>
				clip.type === "video" || clip.type === "audio"
					? [
							[
								"mediaId" in clip ? clip.mediaId : null,
								"sourceUrl" in clip ? clip.sourceUrl : null,
								clip.startTime,
								clip.duration,
								clip.trimStart,
								clip.retime ?? null,
								clip.params.volume ?? null,
								clip.params.muted ?? null,
								clip.params.noiseReduction ?? null,
								clip.type === "video" ? (clip.isSourceAudioEnabled ?? null) : null,
								clip.animations?.volume ?? null,
							],
						]
					: [],
			),
		}));
	// FNV-1a: quick, and only ever compared with itself.
	const text = JSON.stringify(audible);
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${hash.toString(16).padStart(8, "0")}-${text.length.toString(16)}`;
}

/**
 * The words the narration says, from the project's caption words, then from
 * `splice`'s cached transcripts for recordings those don't cover. Without
 * `splice` (as in tests), the caption words alone.
 */
async function speechSources({
	editor,
	sequence,
}: {
	editor: EditorCore;
	sequence: TSequence;
}): Promise<CaptionsRequest["sources"]> {
	const stored = [
		...(editor.project.getActiveOrNull()?.captions?.sources ?? []),
		...(sequence.captions?.sources ?? []),
	];
	const covered = new Set(stored.map(({ projectItemId }) => projectItemId));
	try {
		const { sources } = await fetchTranscriptSources({ editor });
		return [
			...stored,
			...sources.filter(({ projectItemId }) => !covered.has(projectItemId)),
		];
	} catch {
		return stored;
	}
}

/** Integrated loudness of a music file, or null if it can't be measured. */
async function measureItem({
	item,
	signal,
}: {
	item: ProjectItem;
	signal?: AbortSignal;
}): Promise<number | null> {
	try {
		const buffer = await decodeAudioRange({
			file: item.file,
			range: { start: 0, end: item.duration ?? 0 },
			sampleRate: MEASURE_SAMPLE_RATE,
			signal,
		});
		if (!buffer) return null;
		const { integratedLufs } = await measureMix({
			audio: {
				channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
					buffer.getChannelData(channel),
				),
				sampleRate: buffer.sampleRate,
			},
			signal,
		});
		return integratedLufs;
	} catch (error) {
		signal?.throwIfAborted();
		console.warn("Couldn't measure the music:", error);
		return null;
	}
}

/** The clip gain that puts music `DEFAULT_MUSIC_QUIET_LU` under the narration target. */
export function musicLevelDb({ musicLufs }: { musicLufs: number | null }) {
	if (musicLufs === null) return DEFAULT_MUSIC_LEVEL_DB;
	const level = DEFAULT_TARGET_LUFS + DEFAULT_MUSIC_QUIET_LU - musicLufs;
	return Math.round(Math.min(VOLUME_DB_MAX, Math.max(VOLUME_DB_MIN, level)) * 10) / 10;
}

export interface MusicReport {
	music: MusicSettings;
	clipCount: number;
	lengthSeconds: number;
	/** Passages the music ducks under, in sequence seconds. */
	duckedPassages: Array<{ start: number; end: number }>;
	/** Recordings without a transcript, ducked wherever they play. */
	untranscribedItemIds: string[];
}

/** Refits, refades and reducks the music from `settings`, as one undo step. */
async function applyMusic({
	editor,
	sequenceId,
	settings,
	label,
	check,
}: {
	editor: EditorCore;
	sequenceId: string;
	settings: MusicSettings;
	label: string;
	/** Throws to stop before the edit, e.g. when the sequence changed meanwhile. */
	check?: () => void;
}): Promise<MusicReport> {
	const before = findSequence({ editor, sequenceId });
	const sources = await speechSources({ editor, sequence: before });
	// Built on the sequence as it is once the transcripts are in.
	const sequence = findSequence({ editor, sequenceId });
	const projectItems = editor.media.getProjectItems();
	const item = projectItems.find(({ id }) => id === settings.projectItemId);
	if (!item)
		throw new MusicError(
			`Project item ${settings.projectItemId} is no longer in the project.`,
		);
	const { passages: speech, untranscribedItemIds } = speechPassages({
		tracks: sequence.tracks,
		projectItems,
		sources,
		music: settings,
	});
	const { tracks, passages } = withMusic({
		tracks: sequence.tracks,
		settings,
		item,
		speech,
	});
	check?.();
	editor.command.execute({
		command: new UpdateSequenceCommand({
			editor,
			sequenceId,
			updates: { tracks, mix: { ...sequence.mix, music: settings } },
			label,
		}),
	});
	const track = tracks.audio.find((candidate) =>
		isMusicTrack({ track: candidate, music: settings }),
	);
	const round = (value: number) => Math.round(value * 100) / 100;
	return {
		music: settings,
		clipCount: track?.clips.length ?? 0,
		lengthSeconds: round(contentEndSeconds({ tracks, music: settings })),
		duckedPassages: passages.map(({ start, end }) => ({
			start: round(start),
			end: round(end),
		})),
		untranscribedItemIds,
	};
}

type MusicOptions = Omit<UpdateMusicRequest, "sequenceId" | "expectedRevision" | "label">;

/** Uses an audio project item as the sequence's music, replacing any music it had. */
export async function addMusic({
	editor,
	sequenceId,
	projectItemId,
	options = {},
	label = "Add music",
	signal,
	check,
}: {
	editor: EditorCore;
	sequenceId: string;
	projectItemId: string;
	options?: MusicOptions;
	label?: string;
	signal?: AbortSignal;
	check?: () => void;
}): Promise<MusicReport> {
	const item = editor.media
		.getProjectItems()
		.find(({ id }) => id === projectItemId);
	if (!item) throw new MusicError(`Unknown project item ${projectItemId}.`);
	if (item.type !== "audio")
		throw new MusicError(`${item.name} isn't an audio file. Pick a music track.`);
	if (item.missing)
		throw new MusicError(`${item.name} is missing from Footage. Relink it first.`);
	const musicLufs =
		options.levelDb === undefined ? await measureItem({ item, signal }) : null;
	const current = findSequence({ editor, sequenceId }).mix?.music;
	const settings: MusicSettings = {
		projectItemId,
		trackId: current?.trackId ?? generateUUID(),
		levelDb: options.levelDb ?? musicLevelDb({ musicLufs }),
		duckDb: options.duckDb ?? current?.duckDb ?? MUSIC_DEFAULTS.duckDb,
		fadeInSeconds:
			options.fadeInSeconds ?? current?.fadeInSeconds ?? MUSIC_DEFAULTS.fadeInSeconds,
		fadeOutSeconds:
			options.fadeOutSeconds ??
			current?.fadeOutSeconds ??
			MUSIC_DEFAULTS.fadeOutSeconds,
		holdPauseSeconds:
			options.holdPauseSeconds ??
			current?.holdPauseSeconds ??
			MUSIC_DEFAULTS.holdPauseSeconds,
		overrides: options.overrides ?? current?.overrides ?? [],
		musicLufs,
	};
	return applyMusic({ editor, sequenceId, settings, label, check });
}

/** Changes the music's mix settings, and refits it to the sequence as it is now. */
export async function updateMusic({
	editor,
	sequenceId,
	options,
	label = "Adjust music",
	check,
}: {
	editor: EditorCore;
	sequenceId: string;
	options: MusicOptions;
	label?: string;
	check?: () => void;
}): Promise<MusicReport> {
	const current = findSequence({ editor, sequenceId }).mix?.music;
	if (!current)
		throw new MusicError("This sequence has no music. Add a track first.");
	const defined = Object.fromEntries(
		Object.entries(options).filter(([, value]) => value !== undefined),
	);
	return applyMusic({
		editor,
		sequenceId,
		settings: { ...current, ...defined },
		label,
		check,
	});
}

/** Removes the music track and its settings, as one undo step. */
export function removeMusic({
	editor,
	sequenceId,
	label = "Remove music",
}: {
	editor: EditorCore;
	sequenceId: string;
	label?: string;
}): void {
	const sequence = findSequence({ editor, sequenceId });
	const music = sequence.mix?.music;
	if (!music) throw new MusicError("This sequence has no music.");
	const { music: _music, ...rest } = sequence.mix ?? {};
	const mix: SequenceMix | undefined = Object.keys(rest).length ? rest : undefined;
	editor.command.execute({
		command: new UpdateSequenceCommand({
			editor,
			sequenceId,
			updates: {
				tracks: {
					...sequence.tracks,
					audio: sequence.tracks.audio.filter(
						(track) => !isMusicTrack({ track, music }),
					),
				},
				mix,
			},
			label,
		}),
	});
}

/**
 * Mixes the sequence as the clips sum, before the final gain: narration,
 * application sounds and music, at their clip volumes and keyframes.
 */
async function renderMix({
	editor,
	sequence,
	signal,
}: {
	editor: EditorCore;
	sequence: TSequence;
	signal?: AbortSignal;
}) {
	const buffer = await createTimelineAudioBuffer({
		tracks: sequence.tracks,
		projectItems: editor.media.getProjectItems(),
		duration: calculateTotalDuration({ tracks: sequence.tracks }),
		signal,
		master: false,
	});
	if (!buffer) return null;
	return {
		channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
			buffer.getChannelData(channel),
		),
		sampleRate: buffer.sampleRate,
	};
}

export interface MixPlan {
	loudness: MixLoudness;
	measured: MixMeasurement;
}

const round1 = (value: number | null) =>
	value === null ? null : Math.round(value * 10) / 10;

/**
 * Measures the whole mix and the gain that brings it to `targetLufs` with its
 * true peak at or under `ceilingDbtp`. Nothing changes until it's saved.
 */
export async function measureMixLoudness({
	editor,
	sequenceId,
	targetLufs = DEFAULT_TARGET_LUFS,
	ceilingDbtp = MAX_TRUE_PEAK_DBTP,
	signal,
}: {
	editor: EditorCore;
	sequenceId: string;
	targetLufs?: number;
	ceilingDbtp?: number;
	signal?: AbortSignal;
}): Promise<MixPlan> {
	const sequence = findSequence({ editor, sequenceId });
	const fingerprint = mixFingerprint({ tracks: sequence.tracks });
	const audio = await renderMix({ editor, sequence, signal });
	if (!audio)
		throw new MusicError("Nothing in this sequence plays audio, so there is no mix to measure.");
	const { gainDb, measured, expected } = await planMixGain({
		audio,
		targetLufs,
		ceilingDbtp,
		signal,
	});
	if (measured.integratedLufs === null)
		throw new MusicError("The mix is silent, or too short to measure.");
	return {
		measured,
		loudness: {
			targetLufs,
			ceilingDbtp,
			gainDb,
			measuredLufs: round1(measured.integratedLufs),
			measuredTruePeakDbtp: round1(measured.truePeakDbtp),
			expectedLufs: round1(expected.integratedLufs),
			expectedTruePeakDbtp: round1(expected.truePeakDbtp),
			fingerprint,
		},
	};
}

/** Saves the whole-mix gain on the sequence, as one undo step. */
export function saveMixLoudness({
	editor,
	sequenceId,
	loudness,
	label = "Set mix loudness",
}: {
	editor: EditorCore;
	sequenceId: string;
	loudness: MixLoudness;
	label?: string;
}): void {
	const sequence = findSequence({ editor, sequenceId });
	editor.command.execute({
		command: new UpdateSequenceCommand({
			editor,
			sequenceId,
			updates: { mix: { ...sequence.mix, loudness } },
			label,
		}),
	});
}

/** Whether the saved mix gain was measured on the audio the sequence plays now. */
export function isMixLoudnessStale({ sequence }: { sequence: TSequence }): boolean {
	const loudness = sequence.mix?.loudness;
	return (
		!!loudness &&
		loudness.fingerprint !== mixFingerprint({ tracks: sequence.tracks })
	);
}
