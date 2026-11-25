import type {
	AudioClip,
	VideoClip,
	LibraryAudioClip,
	RetimeConfig,
	SequenceTracks,
} from "@/timeline";
import { shouldMaintainPitch } from "@/retime/rate";
import type { MediaData, ProjectItem } from "@/media/types";
import { applyAudioMasteringToBuffer } from "@/media/audio-mastering";
import type { MixLoudness } from "@splice/bridge/mix";
import {
	applyMixGain,
	readMasteredSamples,
	type SampleRange,
} from "@/mix/loudness-meter";
import type { AudioCapableClip } from "@/timeline/audio-state";
import {
	hasAnimatedVolume,
	isClipMuted,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { doesClipHaveEnabledAudio } from "@/timeline/audio-separation";
import { canClipHaveAudio, hasMediaId } from "@/timeline/clip-utils";
import { canTrackHaveAudio } from "@/timeline";
import { mediaSupportsAudio } from "@/media/media-utils";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";
import { Input, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import {
	clipAudioMedia,
	createMediaSource,
	isDiskMedia,
	playableProjectItems,
} from "@/media/media-data";
import {
	type AssembledAudio,
	createAudioRangeAssembler,
	getClipSourceRange,
	getDecodeWindow,
	type SourceRange,
} from "@/media/source-range";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	type AudioDecodeSessions,
	createAudioDecodeSessions,
} from "@/media/audio-decode-sessions";
import {
	computeRmsBuckets,
	type SampleBucket,
} from "@/media/waveform-summary";

const MAX_AUDIO_CHANNELS = 2;
export const EXPORT_SAMPLE_RATE = 44100;

interface CollectedAudioClip {
	timelineClip: AudioCapableClip;
	buffer: AudioBuffer;
	startTime: number;
	duration: number;
	/** Seconds into `buffer` where the clip's in point is. */
	trimStart: number;
	volume: number;
	retime?: RetimeConfig;
}

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export async function decodeAudioToFloat32({
	audioBlob,
	sampleRate,
}: {
	audioBlob: Blob;
	sampleRate?: number;
}): Promise<DecodedAudio> {
	const audioContext = createAudioContext({ sampleRate });
	const arrayBuffer = await audioBlob.arrayBuffer();
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

	// mix down to mono
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	const samples = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (let channel = 0; channel < numChannels; channel++) {
			sum += audioBuffer.getChannelData(channel)[i];
		}
		samples[i] = sum / numChannels;
	}

	return { samples, sampleRate: audioBuffer.sampleRate };
}

export interface AudibleClipCandidate {
	clip: AudioClip | VideoClip;
	projectItem: ProjectItem | null;
}

export function collectAudibleCandidates({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): AudibleClipCandidate[] {
	const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const mediaMap = new Map(playableProjectItems(projectItems).map((a) => [a.id, a]));
	const candidates: AudibleClipCandidate[] = [];

	for (const track of allTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const clip of track.clips) {
			if (!canClipHaveAudio(clip)) continue;
			if (clip.duration <= 0) continue;

			const projectItem = hasMediaId(clip)
				? (mediaMap.get(clip.mediaId) ?? null)
				: null;
			if (!doesClipHaveEnabledAudio({ clip, projectItem })) continue;

			candidates.push({ clip, projectItem });
		}
	}

	return candidates;
}

export function timelineHasAudio({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): boolean {
	return collectAudibleCandidates({ tracks, projectItems }).some(
		({ clip }) => !isClipMuted({ clip }),
	);
}

/**
 * Decodes the audible clips one at a time, each from only the part of its
 * source it plays. The export mix holds one clip's audio at a time, so memory
 * follows the sequence, not the length of the recordings behind it.
 */
async function* collectAudioClips({
	candidates,
	audioContext,
	signal,
	window,
	sessions,
}: {
	candidates: AudibleClipCandidate[];
	audioContext: BaseAudioContext;
	signal?: AbortSignal;
	window?: SampleRange;
	/** Open decoders a windowed read continues from, one per clip. */
	sessions?: AudioDecodeSessions;
}): AsyncGenerator<CollectedAudioClip> {
	const sampleRate = window ? EXPORT_SAMPLE_RATE : audioContext.sampleRate;
	for (const { clip, projectItem } of candidates) {
		signal?.throwIfAborted();
		if (isClipMuted({ clip })) continue;
		if (
			clip.type === "video" &&
			!(projectItem && mediaSupportsAudio({ media: projectItem }))
		)
			continue;

		const startTime = clip.startTime / TICKS_PER_SECOND;
		const trimStart = clip.trimStart / TICKS_PER_SECOND;
		const duration = clip.duration / TICKS_PER_SECOND;
		const startSample = Math.floor(startTime * sampleRate);
		const endSample = startSample + Math.ceil(duration * sampleRate);
		if (window && (endSample <= window.start || startSample >= window.end))
			continue;
		const preservePitch = shouldMaintainPitch({
			rate: clip.retime?.rate ?? 1,
			maintainPitch: clip.retime?.maintainPitch,
		});
		// Pitch stretching needs some context on each side. Ordinary resampling
		// also gets a small guard so the resampler is settled by the first sample.
		const pad = Math.round((preservePitch ? 0.25 : 0.02) * sampleRate);
		const from = window
			? Math.max(0, window.start - startSample - pad) / sampleRate
			: 0;
		const to = window
			? Math.min(endSample, window.end + pad) / sampleRate -
				startSample / sampleRate
			: duration;
		const sourceAt = (time: number) =>
			trimStart +
			getSourceTimeAtClipTime({ clipTime: time, retime: clip.retime });
		const range = getClipSourceRange({
			trimStart: sourceAt(from),
			duration: to - from,
			retime: clip.retime,
		});
		// Start bounded resampling on an integer second, which lies on both
		// sample grids. Adjacent ranges then use the same source sample phase.
		if (window) range.start = Math.floor(range.start);
		const media = projectItem && clipAudioMedia({ clip, projectItem });
		const decoded = projectItem && media
			? await resolveAudioBufferForProjectItem({
					projectItem,
					file: media.file,
					range,
					audioContext,
					signal,
					bounded: !!window,
					stream: window &&
						sessions && { sessions, key: `${clip.id}:${media.sourceKey}` },
				})
			: clip.type === "audio" && clip.sourceType === "library"
				? await resolveLibraryAudioBuffer({ clip, audioContext, signal })
				: null;
		if (!decoded) continue;
		const rendered = preservePitch
			? await renderRetimedBuffer({
					audioContext,
					sourceBuffer: decoded.buffer,
					trimStart: sourceAt(from) - decoded.start,
					clipDuration: to - from,
					retime: clip.retime,
					maintainPitch: true,
				})
			: undefined;
		yield {
			timelineClip: clip,
			buffer: rendered ?? decoded.buffer,
			startTime,
			duration,
			trimStart: rendered ? -from : trimStart - decoded.start,
			volume: resolveEffectiveAudioGain({ clip, localTime: 0 }),
			retime: rendered ? undefined : clip.retime,
		};
	}
}

/** Decoded audio and the source time its first sample is at. */
interface DecodedClipAudio {
	buffer: AudioBuffer;
	start: number;
}

async function resolveLibraryAudioBuffer({
	clip,
	audioContext,
	signal,
}: {
	clip: LibraryAudioClip;
	audioContext: BaseAudioContext;
	signal?: AbortSignal;
}): Promise<DecodedClipAudio | null> {
	try {
		if (clip.buffer) return { buffer: clip.buffer, start: 0 };

		// Library sounds are short clips from the sounds API, so they decode whole.
		const response = await fetch(clip.sourceUrl, { signal });
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return {
			buffer: await audioContext.decodeAudioData(arrayBuffer.slice(0)),
			start: 0,
		};
	} catch (error) {
		// A cancelled export stops here rather than skipping to the next clip.
		signal?.throwIfAborted();
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForProjectItem({
	projectItem,
	file,
	range,
	audioContext,
	signal,
	bounded,
	stream,
}: {
	projectItem: ProjectItem;
	/** The item's file, or what `clipAudioMedia` reads the clip's audio from. */
	file: MediaData;
	range: SourceRange;
	audioContext: BaseAudioContext;
	signal?: AbortSignal;
	bounded: boolean;
	/** Continues an open decoder for this clip instead of opening the file again. */
	stream?: { sessions: AudioDecodeSessions; key: string };
}): Promise<DecodedClipAudio | null> {
	// An uploaded audio file is already in memory, so it decodes in one go.
	// Everything else, recordings on disk above all, decodes only the range.
	if (!bounded && projectItem.type === "audio" && !isDiskMedia(file)) {
		try {
			const arrayBuffer = await file.arrayBuffer();
			return {
				buffer: await audioContext.decodeAudioData(arrayBuffer.slice(0)),
				start: 0,
			};
		} catch (error) {
			console.warn("Failed to decode audio projectItem:", error);
			return null;
		}
	}

	try {
		if (stream) {
			const assembled = await stream.sessions.decode({
				key: stream.key,
				file,
				range,
				maxChannels: MAX_AUDIO_CHANNELS,
			});
			return assembled
				? {
						buffer: await toAudioBuffer({
							assembled,
							sampleRate: audioContext.sampleRate,
						}),
						start: range.start,
					}
				: null;
		}
		const buffer = await decodeAudioRange({
			file,
			range,
			sampleRate: audioContext.sampleRate,
			signal,
		});
		return buffer ? { buffer, start: range.start } : null;
	} catch (error) {
		signal?.throwIfAborted();
		console.warn("Failed to decode projectItem audio:", error);
		return null;
	}
}

/**
 * Decodes one range of a source's primary audio track, resampled to
 * `sampleRate`. Sample 0 is `range.start`. mediabunny reads only the packets
 * the range and its decoder pre-roll need, so a file on disk is fetched in
 * byte ranges, never whole.
 */
export async function decodeAudioRange({
	file,
	range,
	sampleRate,
	signal,
}: {
	file: MediaData;
	range: SourceRange;
	sampleRate: number;
	signal?: AbortSignal;
}): Promise<AudioBuffer | null> {
	if (range.end <= range.start) return null;
	const input = new Input({
		source: createMediaSource({ data: file, signal }),
		formats: ALL_FORMATS,
	});
	// Disposing the input rejects a read that is still waiting on the file.
	const disposeInput = () => input.dispose();
	signal?.addEventListener("abort", disposeInput, { once: true });

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const assembler = createAudioRangeAssembler({
			range,
			maxChannels: MAX_AUDIO_CHANNELS,
			timeResolution: audioTrack.timeResolution,
		});
		const sink = new AudioBufferSink(audioTrack);
		const decodeWindow = getDecodeWindow({ range });
		for await (const chunk of sink.buffers(decodeWindow.start, decodeWindow.end)) {
			signal?.throwIfAborted();
			assembler.add(chunk);
		}
		const assembled = assembler.finish();
		return assembled ? await toAudioBuffer({ assembled, sampleRate }) : null;
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	} finally {
		signal?.removeEventListener("abort", disposeInput);
		input.dispose();
	}
}

/** Assembled source audio as an AudioBuffer at `sampleRate`. */
async function toAudioBuffer({
	assembled,
	sampleRate,
}: {
	assembled: AssembledAudio;
	sampleRate: number;
}): Promise<AudioBuffer> {
	const { channels } = assembled;
	const nativeBuffer = new AudioBuffer({
		numberOfChannels: channels.length,
		length: channels[0].length,
		sampleRate: assembled.sampleRate,
	});
	for (let channel = 0; channel < channels.length; channel++) {
		nativeBuffer.copyToChannel(channels[channel], channel);
	}
	if (assembled.sampleRate === sampleRate) return nativeBuffer;

	// OfflineAudioContext gives high-quality resampling to the target rate.
	const offlineContext = new OfflineAudioContext(
		channels.length,
		Math.ceil(nativeBuffer.length * (sampleRate / assembled.sampleRate)),
		sampleRate,
	);
	const sourceNode = offlineContext.createBufferSource();
	sourceNode.buffer = nativeBuffer;
	sourceNode.connect(offlineContext.destination);
	sourceNode.start(0);
	return await offlineContext.startRendering();
}

interface AudioMixSource {
	timelineClip: AudioCapableClip;
	file: MediaData;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	retime?: RetimeConfig;
}

export interface AudioClipSource {
	timelineClip: AudioCapableClip;
	id: string;
	sourceKey: string;
	file: MediaData;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

async function fetchLibraryAudioSource({
	clip,
	volume,
}: {
	clip: LibraryAudioClip;
	volume: number;
}): Promise<AudioMixSource | null> {
	try {
		const response = await fetch(clip.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${clip.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			timelineClip: clip,
			file,
			startTime: clip.startTime / TICKS_PER_SECOND,
			duration: clip.duration / TICKS_PER_SECOND,
			trimStart: clip.trimStart / TICKS_PER_SECOND,
			trimEnd: clip.trimEnd / TICKS_PER_SECOND,
			volume,
			retime: clip.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	clip,
	muted,
	volume,
}: {
	clip: LibraryAudioClip;
	muted: boolean;
	volume: number;
}): Promise<AudioClipSource | null> {
	try {
		const response = await fetch(clip.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${clip.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			timelineClip: clip,
			id: clip.id,
			sourceKey: clip.id,
			file,
			startTime: clip.startTime / TICKS_PER_SECOND,
			duration: clip.duration / TICKS_PER_SECOND,
			trimStart: clip.trimStart / TICKS_PER_SECOND,
			trimEnd: clip.trimEnd / TICKS_PER_SECOND,
			volume,
			muted,
			retime: clip.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioSource({
	clip,
	projectItem,
	volume,
}: {
	clip: AudioCapableClip;
	projectItem: ProjectItem;
	volume: number;
}): AudioMixSource {
	return {
		timelineClip: clip,
		file: clipAudioMedia({ clip, projectItem }).file,
		startTime: clip.startTime / TICKS_PER_SECOND,
		duration: clip.duration / TICKS_PER_SECOND,
		trimStart: clip.trimStart / TICKS_PER_SECOND,
		trimEnd: clip.trimEnd / TICKS_PER_SECOND,
		volume,
		retime: clip.retime,
	};
}

function collectMediaAudioClip({
	clip,
	projectItem,
	muted,
	volume,
}: {
	clip: AudioCapableClip;
	projectItem: ProjectItem;
	muted: boolean;
	volume: number;
}): AudioClipSource {
	const { file, sourceKey } = clipAudioMedia({ clip, projectItem });
	return {
		timelineClip: clip,
		id: clip.id,
		sourceKey,
		file,
		startTime: clip.startTime / TICKS_PER_SECOND,
		duration: clip.duration / TICKS_PER_SECOND,
		trimStart: clip.trimStart / TICKS_PER_SECOND,
		trimEnd: clip.trimEnd / TICKS_PER_SECOND,
		volume,
		muted,
		retime: clip.retime,
	};
}

export async function collectAudioMixSources({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): Promise<AudioMixSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const audioMixSources: AudioMixSource[] = [];
	const mediaMap = new Map<string, ProjectItem>(
		playableProjectItems(projectItems).map((projectItem) => [projectItem.id, projectItem]),
	);
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of orderedTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const clip of track.clips) {
			if (!canClipHaveAudio(clip)) continue;
			if (isClipMuted({ clip })) continue;
			const projectItem = hasMediaId(clip)
				? (mediaMap.get(clip.mediaId) ?? null)
				: null;
			if (!doesClipHaveEnabledAudio({ clip, projectItem })) continue;
			const volume = resolveEffectiveAudioGain({
				clip,
				localTime: 0,
			});

			if (clip.type === "audio") {
				if (clip.sourceType === "upload") {
					const projectItem = mediaMap.get(clip.mediaId);
					if (!projectItem) continue;

					audioMixSources.push(
						collectMediaAudioSource({ clip, projectItem, volume }),
					);
				} else {
					pendingLibrarySources.push(
						fetchLibraryAudioSource({ clip, volume }),
					);
				}
				continue;
			}

			if (clip.type === "video") {
				if (projectItem && mediaSupportsAudio({ media: projectItem })) {
					audioMixSources.push(
						collectMediaAudioSource({ clip, projectItem, volume }),
					);
				}
			}
		}
	}

	const resolvedLibrarySources = await Promise.all(pendingLibrarySources);
	for (const source of resolvedLibrarySources) {
		if (source) audioMixSources.push(source);
	}

	return audioMixSources;
}

export async function collectAudioClipSources({
	tracks,
	projectItems,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
}): Promise<AudioClipSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, ProjectItem>(
		playableProjectItems(projectItems).map((projectItem) => [projectItem.id, projectItem]),
	);
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of orderedTracks) {
		const isTrackMuted = canTrackHaveAudio(track) && track.muted;

		for (const clip of track.clips) {
			if (!canClipHaveAudio(clip)) continue;

			const projectItem = hasMediaId(clip)
				? (mediaMap.get(clip.mediaId) ?? null)
				: null;
			if (!doesClipHaveEnabledAudio({ clip, projectItem })) continue;

			const muted = isTrackMuted || isClipMuted({ clip });
			const volume = resolveEffectiveAudioGain({
				clip,
				trackMuted: isTrackMuted,
				localTime: 0,
			});

			if (clip.type === "audio") {
				if (clip.sourceType === "upload") {
					const projectItem = mediaMap.get(clip.mediaId);
					if (!projectItem) continue;

					clips.push(
						collectMediaAudioClip({
							clip,
							projectItem,
							muted,
							volume,
						}),
					);
				} else {
					pendingLibraryClips.push(
						fetchLibraryAudioClip({ clip, muted, volume }),
					);
				}
				continue;
			}

			if (clip.type === "video") {
				if (projectItem && mediaSupportsAudio({ media: projectItem })) {
					clips.push(
						collectMediaAudioClip({
							clip,
							projectItem,
							muted,
							volume,
						}),
					);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

/**
 * Mixes the sequence's audio for export; rejects with `signal`'s reason once
 * it aborts. When the final mix has been measured, its gain and true-peak
 * ceiling apply. `master: false` returns the unmastered sum for measurement.
 */
export async function createTimelineAudioBuffer({
	tracks,
	projectItems,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
	signal,
	master,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	duration: number;
	sampleRate?: number;
	audioContext?: BaseAudioContext;
	signal?: AbortSignal;
	master?: Pick<MixLoudness, "gainDb" | "ceilingDbtp"> | false;
}): Promise<AudioBuffer | null> {
	signal?.throwIfAborted();
	const context = audioContext ?? new OfflineAudioContext(2, 1, sampleRate);

	const outputChannels = 2;
	const durationSeconds = duration / TICKS_PER_SECOND;
	const outputLength = Math.ceil(durationSeconds * sampleRate);
	let outputBuffer: AudioBuffer | null = null;

	for await (const clip of collectAudioClips({
		candidates: collectAudibleCandidates({ tracks, projectItems }),
		audioContext: context,
		signal,
	})) {
		outputBuffer ??= context.createBuffer(
			outputChannels,
			outputLength,
			sampleRate,
		);

		mixAudioChannels({
			clip,
			buffer: clip.buffer,
			trimStart: clip.trimStart,
			retime: clip.retime,
			outputBuffer,
			outputLength,
			sampleRate,
		});
	}

	signal?.throwIfAborted();
	if (!outputBuffer) return null;
	if (master === false) return outputBuffer;
	if (!master) return applyAudioMasteringToBuffer({ audioBuffer: outputBuffer });
	const mixed = outputBuffer;
	await applyMixGain({
		audio: {
			channels: Array.from({ length: mixed.numberOfChannels }, (_, channel) =>
				mixed.getChannelData(channel),
			),
			sampleRate,
		},
		gainDb: master.gainDb,
		ceilingDbtp: master.ceilingDbtp,
		signal,
	});
	return outputBuffer;
}

/**
 * Reads the timeline on a fixed sample grid, keeping only the most recent
 * dry tiles. The same dry tiles feed preview, loudness measurement and export.
 */
export function createTimelineAudioReader({
	tracks,
	projectItems,
	duration,
	signal,
	audioContext,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	duration: number;
	signal?: AbortSignal;
	audioContext?: BaseAudioContext;
}) {
	const candidates = collectAudibleCandidates({ tracks, projectItems }).filter(
		({ clip }) => !isClipMuted({ clip }),
	);
	if (candidates.length === 0 || duration <= 0) return null;
	const sampleRate = EXPORT_SAMPLE_RATE;
	const context = audioContext ?? new OfflineAudioContext(2, 1, sampleRate);
	const length = Math.ceil((duration / TICKS_PER_SECOND) * sampleRate);
	const tileLength = sampleRate;
	// The pitch stretcher starts afresh for each tile. Overlap the joins so
	// differences in its alignment cannot turn into clicks.
	const overlap = candidates.some(({ clip }) =>
		shouldMaintainPitch({
			rate: clip.retime?.rate ?? 1,
			maintainPitch: clip.retime?.maintainPitch,
		}),
	)
		? Math.round(0.02 * sampleRate)
		: 0;
	const tiles = new Map<number, AudioBuffer>();
	const sessions = createAudioDecodeSessions({ signal });
	signal?.addEventListener("abort", () => sessions.dispose(), { once: true });
	const getTile = async (tileStart: number) => {
		const cached = tiles.get(tileStart);
		if (cached) return cached;
		const end = Math.min(tileStart + tileLength + overlap, length);
		const tile = context.createBuffer(2, end - tileStart, sampleRate);
		for await (const clip of collectAudioClips({
			candidates,
			audioContext: context,
			signal,
			window: { start: tileStart, end },
			sessions,
		})) {
			mixAudioChannels({
				clip,
				buffer: clip.buffer,
				trimStart: clip.trimStart,
				retime: clip.retime,
				outputBuffer: tile,
				outputLength: tile.length,
				outputStart: tileStart,
				sampleRate,
			});
		}
		if (tiles.size === 3) {
			const oldest = tiles.keys().next();
			if (!oldest.done) tiles.delete(oldest.value);
		}
		tiles.set(tileStart, tile);
		return tile;
	};
	const read = async ({ start, end }: SampleRange) => {
		const channels = [
			new Float32Array(end - start),
			new Float32Array(end - start),
		];
		for (let offset = start; offset < end; ) {
			signal?.throwIfAborted();
			const tileStart = Math.floor(offset / tileLength) * tileLength;
			const tileEnd = Math.min(tileStart + tileLength, length);
			const back =
				tileStart > 0 && offset < tileStart + overlap
					? await getTile(tileStart - tileLength)
					: null;
			const tile = await getTile(tileStart);
			const next = Math.min(end, tileEnd);
			channels.forEach((data, channel) => {
				data.set(
					tile
						.getChannelData(channel)
						.subarray(offset - tileStart, next - tileStart),
					offset - start,
				);
				if (!back) return;
				const tail = back.getChannelData(channel);
				for (
					let index = offset;
					index < Math.min(next, tileStart + overlap);
					index++
				) {
					const local = index - tileStart;
					const fraction = local / overlap;
					data[index - start] =
						tail[tileLength + local] * (1 - fraction) +
						data[index - start] * fraction;
				}
			});
			offset = next;
		}
		return channels;
	};
	return {
		read,
		length,
		sampleRate,
		channelCount: 2,
		/** Closes the decoders the reads kept open. */
		dispose: () => sessions.dispose(),
		async *blocks({
			master,
			fromSeconds = 0,
		}: {
			master: Pick<MixLoudness, "gainDb" | "ceilingDbtp">;
			fromSeconds?: number;
		}) {
			try {
				for (let start = Math.floor(fromSeconds * sampleRate); start < length; ) {
					signal?.throwIfAborted();
					const end = Math.min(
						length,
						(Math.floor(start / sampleRate) + 1) * sampleRate,
					);
					const channels = await readMasteredSamples({
						read,
						start,
						end,
						length,
						sampleRate,
						...master,
					});
					signal?.throwIfAborted();
					const buffer = context.createBuffer(2, end - start, sampleRate);
					channels.forEach((data, channel) =>
						buffer.getChannelData(channel).set(data),
					);
					yield { buffer, time: start / sampleRate };
					start = end;
				}
			} finally {
				// A later read opens what it needs again.
				sessions.dispose();
			}
		},
	};
}

function collectPeakRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): Float32Array {
	const channels = buffer.numberOfChannels;
	const peaks = new Float32Array(count);

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < count; i++) {
			const { bucketStart: start, bucketEnd: end } = getSampleBucketRange({
				startSample,
				endSample,
				bucketIndex: i,
				bucketCount: count,
			});
			for (let j = start; j < end; j++) {
				const abs = Math.abs(data[j]);
				if (abs > peaks[i]) peaks[i] = abs;
			}
		}
	}

	return peaks;
}

export function extractPeakRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): number[] {
	return Array.from(
		collectPeakRange({
			buffer,
			count,
			startSample,
			endSample,
		}),
	);
}

export function getSampleBucketRange({
	startSample,
	endSample,
	bucketIndex,
	bucketCount,
}: {
	startSample: number;
	endSample: number;
	bucketIndex: number;
	bucketCount: number;
}): {
	bucketStart: number;
	bucketEnd: number;
} {
	const rangeLength = Math.max(0, endSample - startSample);
	const bucketStart =
		startSample + Math.floor((bucketIndex * rangeLength) / bucketCount);
	const bucketEnd =
		startSample + Math.floor(((bucketIndex + 1) * rangeLength) / bucketCount);
	return {
		bucketStart,
		bucketEnd: Math.max(bucketStart, bucketEnd),
	};
}

export function extractRmsBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	return computeRmsBuckets({ buffer, buckets });
}

/**
 * Computes per-bucket waveform amplitude using the maximum RMS over a short
 * analysis window inside each bucket.
 *
 * A naive mean-RMS over a whole bucket averages silence together with nearby
 * sound, which smears transitions (e.g. the onset of speech) across the
 * bucket and makes the waveform respond late. Taking the max over fixed
 * short windows (~20 ms) preserves the smooth, non-jittery RMS character
 * while making transitions land where they actually happen in the audio.
 *
 * Channels are combined per-window before taking the max, so the measure
 * reflects total energy regardless of stereo layout.
 */
export function extractRmsRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): number[] {
	return extractRmsBuckets({
		buffer,
		buckets: Array.from({ length: count }, (_, bucketIndex) =>
			getSampleBucketRange({
				startSample,
				endSample,
				bucketIndex,
				bucketCount: count,
			}),
		),
	});
}

/** Mixes one clip into the export buffer at its volume; exported for tests. */
export function mixAudioChannels({
	clip,
	buffer,
	trimStart,
	retime,
	outputBuffer,
	outputLength,
	outputStart = 0,
	sampleRate,
}: {
	clip: CollectedAudioClip;
	buffer: AudioBuffer;
	trimStart: number;
	retime?: RetimeConfig;
	outputBuffer: AudioBuffer;
	outputLength: number;
	outputStart?: number;
	sampleRate: number;
}): void {
	const { startTime, duration: clipDuration } = clip;

	const outputStartSample = Math.floor(startTime * sampleRate);
	const renderedLength = Math.ceil(clipDuration * sampleRate);

	const outputChannels = 2;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);

		for (
			let i = Math.max(0, outputStart - outputStartSample);
			i < renderedLength;
			i++
		) {
			const outputIndex = outputStartSample + i - outputStart;
			if (outputIndex >= outputLength) break;

			const clipTime = i / sampleRate;
			const sourceTime =
				trimStart + getSourceTimeAtClipTime({ clipTime, retime });
			const sourceIndex = sourceTime * buffer.sampleRate;
			if (sourceIndex < 0) continue;
			if (sourceIndex >= sourceData.length) break;

			const lowerIndex = Math.floor(sourceIndex);
			const upperIndex = Math.min(sourceData.length - 1, lowerIndex + 1);
			const fraction = sourceIndex - lowerIndex;
			const gain = hasAnimatedVolume({ clip: clip.timelineClip })
				? resolveEffectiveAudioGain({
						clip: clip.timelineClip,
						localTime: clipTime,
					})
				: clip.volume;
			outputData[outputIndex] +=
				(sourceData[lowerIndex] * (1 - fraction) +
					sourceData[upperIndex] * fraction) *
				gain;
		}
	}
}
