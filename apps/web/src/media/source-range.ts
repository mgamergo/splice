import { getSourceTimeAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline";

/** A span of a source, in source seconds; `end` is exclusive. */
export interface SourceRange {
	start: number;
	end: number;
}

/**
 * Source audio decoded past a clip's out point, so interpolation at the last
 * sample and rounding of the clip's duration never run off the decoded range.
 */
const SOURCE_RANGE_TAIL_SECONDS = 0.05;

/**
 * How far before a range decoding starts. AAC and Opus decoders start every
 * packet from the state the packets before it left, so samples decoded with
 * no history come out wrong: AAC needs one frame (about 23 ms) and Opus asks
 * for 80 ms of pre-roll. The assembler drops what lands before the range.
 */
export const DECODER_PREROLL_SECONDS = 0.1;

/** The part of its source a clip plays: its in point through its (retimed) duration. */
export function getClipSourceRange({
	trimStart,
	duration,
	retime,
}: {
	trimStart: number;
	duration: number;
	retime?: RetimeConfig;
}): SourceRange {
	const start = Math.max(0, trimStart);
	const span = Math.max(
		0,
		getSourceTimeAtClipTime({ clipTime: duration, retime }),
	);
	// A clip that ends before its source starts plays none of it.
	const end = Math.max(start, trimStart + span + SOURCE_RANGE_TAIL_SECONDS);
	return { start, end };
}

/** The span to decode so a range comes out right: the range plus decoder pre-roll. */
export function getDecodeWindow({ range }: { range: SourceRange }): SourceRange {
	return {
		start: Math.max(0, range.start - DECODER_PREROLL_SECONDS),
		end: range.end,
	};
}

/** The slice of AudioBuffer that range assembly reads. */
type AudioChunk = Pick<
	AudioBuffer,
	"sampleRate" | "length" | "numberOfChannels" | "getChannelData"
>;

export interface AssembledAudio {
	sampleRate: number;
	/** One array per channel; sample 0 is the range's start. */
	channels: Float32Array<ArrayBuffer>[];
}

/**
 * Copies decoded chunks into arrays that cover exactly one source range, as
 * the chunks stream in. Chunks are placed by timestamp, so the decoder's
 * lead-in before the range and its overshoot past the end are dropped, and a
 * gap in the source stays silent. Memory is the range's length, never the
 * source's.
 */
export function createAudioRangeAssembler({
	range,
	maxChannels,
}: {
	range: SourceRange;
	maxChannels: number;
}) {
	let sampleRate = 0;
	let startSample = 0;
	let channels: Float32Array<ArrayBuffer>[] = [];
	let written = 0;

	return {
		add({ buffer, timestamp }: { buffer: AudioChunk; timestamp: number }) {
			if (channels.length === 0) {
				// The decoded rate can differ from the track's metadata (HE-AAC), so
				// size the arrays from the first chunk.
				sampleRate = buffer.sampleRate;
				startSample = Math.round(range.start * sampleRate);
				const length = Math.max(
					0,
					Math.round(range.end * sampleRate) - startSample,
				);
				channels = Array.from(
					{ length: Math.min(maxChannels, buffer.numberOfChannels) },
					() => new Float32Array(length),
				);
			}
			const length = channels[0].length;
			const offset = Math.round(timestamp * sampleRate) - startSample;
			const from = Math.max(0, -offset);
			const to = Math.min(buffer.length, length - offset);
			if (to <= from) return;
			for (let channel = 0; channel < channels.length; channel++) {
				const source = buffer.getChannelData(
					Math.min(channel, buffer.numberOfChannels - 1),
				);
				channels[channel].set(source.subarray(from, to), offset + from);
			}
			written = Math.max(written, offset + to);
		},
		/** The assembled range, cut short where the source ended, or null if nothing landed in it. */
		finish(): AssembledAudio | null {
			if (written === 0) return null;
			return {
				sampleRate,
				channels: channels.map((data) => data.subarray(0, written)),
			};
		},
	};
}
