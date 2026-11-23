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
import { createMediaSource, isDiskMedia, playableProjectItems } from "@/media/media-data";
import {
	createAudioRangeAssembler,
	getClipSourceRange,
	type SourceRange,
} from "@/media/source-range";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	computeRmsBuckets,
	type SampleBucket,
} from "@/media/waveform-summary";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;

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
	tracks,
	projectItems,
	audioContext,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	audioContext: AudioContext;
}): AsyncGenerator<CollectedAudioClip> {
	const mediaMap = new Map<string, ProjectItem>(
		playableProjectItems(projectItems).map((media) => [media.id, media]),
	);

	for (const { clip, projectItem } of collectAudibleCandidates({
		tracks,
		projectItems,
	})) {
		if (isClipMuted({ clip })) continue;
		if (
			clip.type === "video" &&
			!(projectItem && mediaSupportsAudio({ media: projectItem }))
		) {
			continue;
		}

		const trimStart = clip.trimStart / TICKS_PER_SECOND;
		const duration = clip.duration / TICKS_PER_SECOND;
		const decoded =
			clip.type === "audio"
				? await resolveAudioBufferForClip({ clip, mediaMap, audioContext })
				: projectItem
					? await resolveAudioBufferForProjectItem({
							projectItem,
							range: getClipSourceRange({
								trimStart,
								duration,
								retime: clip.retime,
							}),
							audioContext,
						})
					: null;
		if (!decoded) continue;

		yield {
			timelineClip: clip,
			buffer: decoded.buffer,
			startTime: clip.startTime / TICKS_PER_SECOND,
			duration,
			trimStart: trimStart - decoded.start,
			volume: resolveEffectiveAudioGain({
				clip,
				trackMuted: false,
				localTime: 0,
			}),
			retime: clip.retime,
		};
	}
}

/** Decoded audio and the source time its first sample is at. */
interface DecodedClipAudio {
	buffer: AudioBuffer;
	start: number;
}

async function resolveAudioBufferForClip({
	clip,
	mediaMap,
	audioContext,
}: {
	clip: AudioClip;
	mediaMap: Map<string, ProjectItem>;
	audioContext: AudioContext;
}): Promise<DecodedClipAudio | null> {
	try {
		if (clip.sourceType === "upload") {
			const projectItem = mediaMap.get(clip.mediaId);
			if (!projectItem) return null;
			return await resolveAudioBufferForProjectItem({
				projectItem,
				range: getClipSourceRange({
					trimStart: clip.trimStart / TICKS_PER_SECOND,
					duration: clip.duration / TICKS_PER_SECOND,
					retime: clip.retime,
				}),
				audioContext,
			});
		}

		if (clip.buffer) return { buffer: clip.buffer, start: 0 };

		// Library sounds are short clips from the sounds API, so they decode whole.
		const response = await fetch(clip.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return {
			buffer: await audioContext.decodeAudioData(arrayBuffer.slice(0)),
			start: 0,
		};
	} catch (error) {
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForProjectItem({
	projectItem,
	range,
	audioContext,
}: {
	projectItem: ProjectItem;
	range: SourceRange;
	audioContext: AudioContext;
}): Promise<DecodedClipAudio | null> {
	// An uploaded audio file is already in memory, so it decodes in one go.
	// Everything else, recordings on disk above all, decodes only the range.
	if (projectItem.type === "audio" && !isDiskMedia(projectItem.file)) {
		try {
			const arrayBuffer = await projectItem.file.arrayBuffer();
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
		const buffer = await decodeAudioRange({
			file: projectItem.file,
			range,
			sampleRate: audioContext.sampleRate,
		});
		return buffer ? { buffer, start: range.start } : null;
	} catch (error) {
		console.warn("Failed to decode projectItem audio:", error);
		return null;
	}
}

/**
 * Decodes one range of a source's primary audio track, resampled to
 * `sampleRate`. Sample 0 is `range.start`. mediabunny reads only the packets
 * the range needs (from the one before it, for decoder lead-in), so a file on
 * disk is fetched in byte ranges, never whole.
 */
export async function decodeAudioRange({
	file,
	range,
	sampleRate,
}: {
	file: MediaData;
	range: SourceRange;
	sampleRate: number;
}): Promise<AudioBuffer | null> {
	const input = new Input({
		source: createMediaSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const assembler = createAudioRangeAssembler({
			range,
			maxChannels: MAX_AUDIO_CHANNELS,
		});
		const sink = new AudioBufferSink(audioTrack);
		for await (const chunk of sink.buffers(range.start, range.end)) {
			assembler.add(chunk);
		}
		const assembled = assembler.finish();
		if (!assembled) return null;

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
	} finally {
		input.dispose();
	}
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
		file: projectItem.file,
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
	return {
		timelineClip: clip,
		id: clip.id,
		sourceKey: projectItem.id,
		file: projectItem.file,
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

export async function createTimelineAudioBuffer({
	tracks,
	projectItems,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	duration: number;
	sampleRate?: number;
	audioContext?: AudioContext;
}): Promise<AudioBuffer | null> {
	const context = audioContext ?? createAudioContext({ sampleRate });

	const outputChannels = 2;
	const durationSeconds = duration / TICKS_PER_SECOND;
	const outputLength = Math.ceil(durationSeconds * sampleRate);
	let outputBuffer: AudioBuffer | null = null;

	for await (const clip of collectAudioClips({
		tracks,
		projectItems,
		audioContext: context,
	})) {
		outputBuffer ??= context.createBuffer(
			outputChannels,
			outputLength,
			sampleRate,
		);

		const renderedBuffer = shouldMaintainPitch({
			rate: clip.retime?.rate ?? 1,
			maintainPitch: clip.retime?.maintainPitch,
		})
			? await renderRetimedBuffer({
					audioContext: context,
					sourceBuffer: clip.buffer,
					trimStart: clip.trimStart,
					clipDuration: clip.duration,
					retime: clip.retime,
					maintainPitch: true,
				})
			: undefined;

		mixAudioChannels({
			clip,
			buffer: renderedBuffer ?? clip.buffer,
			trimStart: renderedBuffer ? 0 : clip.trimStart,
			retime: renderedBuffer ? undefined : clip.retime,
			outputBuffer,
			outputLength,
			sampleRate,
		});
	}

	if (!outputBuffer) return null;
	return await applyAudioMasteringToBuffer({ audioBuffer: outputBuffer });
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
	sampleRate,
}: {
	clip: CollectedAudioClip;
	buffer: AudioBuffer;
	trimStart: number;
	retime?: RetimeConfig;
	outputBuffer: AudioBuffer;
	outputLength: number;
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

		for (let i = 0; i < renderedLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex >= outputLength) break;

			const clipTime = i / sampleRate;
			const sourceTime =
				trimStart + getSourceTimeAtClipTime({ clipTime, retime });
			const sourceIndex = sourceTime * buffer.sampleRate;
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
