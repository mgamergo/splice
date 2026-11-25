import {
	ALL_FORMATS,
	AudioBufferSink,
	Input,
	type InputAudioTrack,
	type WrappedAudioBuffer,
} from "mediabunny";
import { createMediaSource } from "@/media/media-data";
import type { MediaData } from "@/media/types";
import {
	type AssembledAudio,
	createAudioRangeAssembler,
	DECODER_PREROLL_SECONDS,
	getDecodeWindow,
	type SourceRange,
} from "@/media/source-range";

/**
 * How far past the decoded audio a read may start and still continue the
 * decoder rather than seek it. Decoding a second of audio costs far less than
 * a seek, which reopens the packet index and loses the decoder's history.
 */
const CONTINUE_WITHIN_SECONDS = 2;

/** Decoded audio kept behind the newest read, for the overlap the next read asks for again. */
const KEEP_BEHIND_SECONDS = 1.5;

interface DecodeSession {
	input: Input;
	track: InputAudioTrack | null;
	sink: AudioBufferSink | null;
	iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null;
	/** Decoded chunks in source order, from the oldest a later read may need. */
	chunks: WrappedAudioBuffer[];
	ended: boolean;
	lastUsed: number;
}

/**
 * Keeps a decoder per stream open between reads, so reading a sequence's
 * audio tile by tile decodes each recording once, in order, instead of
 * opening the file, parsing its packet index and seeking for every tile.
 * A read far from the last one seeks the stream; reads must not overlap in
 * time for the same stream.
 */
export function createAudioDecodeSessions({
	signal,
	maxSessions = 8,
}: {
	signal?: AbortSignal;
	/** Open streams kept at once; the least recently read closes first. */
	maxSessions?: number;
}) {
	const sessions = new Map<string, Promise<DecodeSession>>();
	let clock = 0;

	const open = (file: MediaData): Promise<DecodeSession> => {
		const input = new Input({
			source: createMediaSource({ data: file, signal }),
			formats: ALL_FORMATS,
		});
		return input.getPrimaryAudioTrack().then(
			(track) => ({
				input,
				track,
				sink: track ? new AudioBufferSink(track) : null,
				iterator: null,
				chunks: [],
				ended: false,
				lastUsed: clock,
			}),
			(error: unknown) => {
				input.dispose();
				throw error;
			},
		);
	};

	const close = (key: string) => {
		const session = sessions.get(key);
		sessions.delete(key);
		void session
			?.then((opened) => {
				void opened.iterator?.return();
				opened.input.dispose();
			})
			.catch(() => {});
	};

	const evict = async () => {
		if (sessions.size <= maxSessions) return;
		const entries = await Promise.all(
			[...sessions].map(async ([key, session]) => {
				try {
					return { key, lastUsed: (await session).lastUsed };
				} catch {
					return { key, lastUsed: -1 };
				}
			}),
		);
		entries.sort((a, b) => a.lastUsed - b.lastUsed);
		for (const { key } of entries.slice(0, sessions.size - maxSessions))
			close(key);
	};

	/** Decodes `range` of the stream, at the source's own sample rate. */
	async function decode({
		key,
		file,
		range,
		maxChannels,
	}: {
		/** One stream: reads through it should move forward in source time. */
		key: string;
		file: MediaData;
		range: SourceRange;
		maxChannels: number;
	}): Promise<AssembledAudio | null> {
		if (range.end <= range.start) return null;
		let pending = sessions.get(key);
		if (!pending) {
			pending = open(file);
			sessions.set(key, pending);
			pending.catch(() => sessions.delete(key));
			await evict();
		}
		const session = await pending;
		session.lastUsed = ++clock;
		const { track, sink } = session;
		if (!track || !sink) return null;

		const window = getDecodeWindow({ range });
		const first = session.chunks[0];
		const decodedTo = decodedEnd(session);
		const canContinue =
			session.iterator !== null &&
			first !== undefined &&
			first.timestamp <= window.start &&
			window.start <= decodedTo + CONTINUE_WITHIN_SECONDS;
		if (!canContinue && !(session.ended && first && first.timestamp <= window.start)) {
			await session.iterator?.return();
			session.chunks = [];
			session.ended = false;
			session.iterator = sink.buffers(window.start);
		}

		try {
			while (!session.ended && decodedEnd(session) < range.end) {
				signal?.throwIfAborted();
				const next = await session.iterator!.next();
				if (next.done) session.ended = true;
				else session.chunks.push(next.value);
			}
		} catch (error) {
			// mediabunny's decoder stays failed; the next read opens the file afresh.
			if (sessions.get(key) === pending) close(key);
			throw error;
		}
		signal?.throwIfAborted();

		const assembler = createAudioRangeAssembler({
			range,
			maxChannels,
			timeResolution: track.timeResolution,
		});
		for (const chunk of session.chunks) {
			if (chunk.timestamp + chunk.duration <= window.start) continue;
			if (chunk.timestamp >= range.end) break;
			assembler.add(chunk);
		}
		const keepFrom = range.start - DECODER_PREROLL_SECONDS - KEEP_BEHIND_SECONDS;
		const firstKept = session.chunks.findIndex(
			(chunk) => chunk.timestamp + chunk.duration > keepFrom,
		);
		session.chunks =
			firstKept === -1 ? session.chunks.slice(-1) : session.chunks.slice(firstKept);
		return assembler.finish();
	}

	return {
		decode,
		/** Closes the stream, e.g. once the reads have passed the clip it plays. */
		close,
		dispose() {
			for (const key of [...sessions.keys()]) close(key);
		},
	};
}

export type AudioDecodeSessions = ReturnType<typeof createAudioDecodeSessions>;

function decodedEnd(session: DecodeSession): number {
	const last = session.chunks.at(-1);
	return last ? last.timestamp + last.duration : -Infinity;
}
