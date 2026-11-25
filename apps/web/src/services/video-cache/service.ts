import {
	Input,
	ALL_FORMATS,
	CanvasSink,
	EncodedPacketSink,
	VideoSampleSink,
	type InputVideoTrack,
} from "mediabunny";
import { createMediaSource } from "@/media/media-data";
import type { MediaData } from "@/media/types";

/** One decoded frame of a video, ready to draw or upload to the GPU. */
export interface DecodedFrame {
	/**
	 * A WebCodecs VideoFrame, which the compositor copies on the GPU straight
	 * from the decoder's memory, or a canvas for rotated video.
	 */
	source: VideoFrame | OffscreenCanvas | HTMLCanvasElement;
	width: number;
	height: number;
	/** Seconds. */
	timestamp: number;
	duration: number;
}

/**
 * Decoded frames the cache keeps open per video; the decoder stalls if too
 * many stay open. A frame a render still holds closes when it lets go.
 */
const OPEN_FRAMES = 4;

interface VideoSinkData {
	input: Input;
	frames: (startTimestamp: number) => AsyncGenerator<DecodedFrame, void, unknown>;
	iterator: AsyncGenerator<DecodedFrame, void, unknown> | null;
	currentFrame: DecodedFrame | null;
	nextFrame: DecodedFrame | null;
	/** Frames decoded, oldest first; retired as newer ones arrive. */
	open: VideoFrame[];
	/** Finds the key frame a seek can show at once. */
	packets: EncodedPacketSink;
	/** The time a key frame was shown for, while decoding on towards it. */
	refining: number | null;
	/** When a render last asked this video for a frame. */
	requestedAt: number;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

/**
 * Decodes to VideoFrames, which stay in the decoder's (GPU) memory until the
 * compositor copies them, instead of drawing every frame into a 2D canvas
 * first. Rotated video keeps the canvas path, which applies the rotation.
 */
function frameSource({
	track,
	admit,
}: {
	track: InputVideoTrack;
	/** Takes ownership of each decoded frame. */
	admit: (frame: VideoFrame) => void;
}): VideoSinkData["frames"] {
	if (track.rotation !== 0 || typeof VideoFrame === "undefined") {
		const sink = new CanvasSink(track, { poolSize: OPEN_FRAMES, fit: "contain" });
		return async function* (startTimestamp) {
			for await (const { canvas, timestamp, duration } of sink.canvases(
				startTimestamp,
			))
				yield { source: canvas, width: canvas.width, height: canvas.height, timestamp, duration };
		};
	}
	const sink = new VideoSampleSink(track);
	return async function* (startTimestamp) {
		for await (const sample of sink.samples(startTimestamp)) {
			const { timestamp, duration } = sample;
			let frame: VideoFrame;
			try {
				frame = sample.toVideoFrame();
			} finally {
				sample.close();
			}
			admit(frame);
			yield {
				source: frame,
				width: frame.displayWidth,
				height: frame.displayHeight,
				timestamp,
				duration,
			};
		}
	};
}

export class VideoCache {
	/** Stops this cache's reads, so a cancelled export isn't held up by one that stalls. */
	private readonly signal?: AbortSignal;
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();
	/** How many renders hold each frame handed out. */
	private leases = new Map<VideoFrame, number>();
	/** Frames the cache let go of while a render still held them. */
	private retired = new Set<VideoFrame>();

	constructor({ signal }: { signal?: AbortSignal } = {}) {
		this.signal = signal;
	}

	/**
	 * Lets go of a frame `getFrameAt` returned, once the render has uploaded or
	 * drawn it. Every frame it returns must be released exactly once.
	 */
	release(frame: DecodedFrame | null): void {
		if (!frame || !(frame.source instanceof VideoFrame)) return;
		const source = frame.source;
		const held = (this.leases.get(source) ?? 0) - 1;
		if (held > 0) {
			this.leases.set(source, held);
			return;
		}
		this.leases.delete(source);
		if (this.retired.delete(source)) source.close();
	}

	private lease(frame: DecodedFrame | null): DecodedFrame | null {
		if (frame?.source instanceof VideoFrame)
			this.leases.set(frame.source, (this.leases.get(frame.source) ?? 0) + 1);
		return frame;
	}

	/** Closes a frame the cache no longer keeps, or once its last render lets go. */
	private retire(frame: VideoFrame): void {
		if (this.leases.has(frame)) this.retired.add(frame);
		else frame.close();
	}

	private admit({
		sinkData,
		frame,
	}: {
		sinkData: VideoSinkData;
		frame: VideoFrame;
	}): void {
		sinkData.open.push(frame);
		while (sinkData.open.length > OPEN_FRAMES) {
			const oldest = sinkData.open.shift();
			if (oldest) this.retire(oldest);
		}
	}

	/**
	 * Whether a video shown recently is still on a key frame while the exact
	 * frame decodes. The preview keeps rendering until it is not.
	 */
	isRefining(): boolean {
		const recent = performance.now() - 1000;
		for (const sink of this.sinks.values())
			if (sink.refining !== null && sink.requestedAt >= recent) return true;
		return false;
	}

	async getFrameAt({
		mediaId,
		file,
		time,
		keyFrameFirst = false,
	}: {
		mediaId: string;
		file: MediaData;
		time: number;
		/**
		 * Answers a far seek with the key frame before it at once, then decodes
		 * on to the exact frame over the following requests. A recording's key
		 * frames can be eight seconds apart, so an exact seek decodes up to 240
		 * frames before anything shows; scrubbing should never wait for that.
		 */
		keyFrameFirst?: boolean;
	}): Promise<DecodedFrame | null> {
		// Release the frame after rendering it: see `release`.
		await this.ensureSink({ mediaId, file });

		const sinkData = this.sinks.get(mediaId);
		if (!sinkData) return null;

		const generation = (this.seekGenerations.get(mediaId) ?? 0) + 1;
		this.seekGenerations.set(mediaId, generation);
		sinkData.requestedAt = performance.now();
		const isCurrent = () => this.seekGenerations.get(mediaId) === generation;

		const previous = this.frameChain.get(mediaId) ?? Promise.resolve();
		// The lease is taken before the next request for this video can retire it.
		const current = previous.then(async () =>
			this.lease(
				isCurrent()
					? await this.resolveFrame({ sinkData, time, isCurrent, keyFrameFirst })
					: (sinkData.currentFrame ?? null),
			),
		);
		this.frameChain.set(
			mediaId,
			current.catch(() => {}),
		);
		return current;
	}

	private async resolveFrame({
		sinkData,
		time,
		isCurrent,
		keyFrameFirst,
	}: {
		sinkData: VideoSinkData;
		time: number;
		/** False once a newer request for this video has come in. */
		isCurrent: () => boolean;
		keyFrameFirst: boolean;
	}): Promise<DecodedFrame | null> {
		const { frame, approximate } = await this.findFrame({
			sinkData,
			time,
			isCurrent: keyFrameFirst ? isCurrent : () => true,
			keyFrameFirst,
		});
		sinkData.refining = frame && approximate ? time : null;
		return frame;
	}

	private async findFrame({
		sinkData,
		time,
		isCurrent,
		keyFrameFirst,
	}: {
		sinkData: VideoSinkData;
		time: number;
		/** Iteration stops early, showing what it has, once this is false. */
		isCurrent: () => boolean;
		keyFrameFirst: boolean;
	}): Promise<{ frame: DecodedFrame | null; approximate: boolean }> {
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return { frame: sinkData.currentFrame, approximate: false };
		}

		// Decoding on is cheaper than a seek within two seconds. After a
		// key-frame-first seek it is also how the exact frame arrives, and how
		// playback that starts there moves on through the rest of the GOP.
		const refining = sinkData.refining;
		const continuing =
			refining !== null && time >= sinkData.lastTime && time < refining + 2.0;
		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			(time < sinkData.lastTime + 2.0 || continuing)
		) {
			const frame = await this.iterateToTime({
				sinkData,
				targetTime: time,
				isCurrent,
			});
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				// Short of the target only when a newer request cut it off.
				return { frame, approximate: !this.isFrameValid({ frame, time }) };
			}
		}

		// Refining that ran out (a gap in the video, or its end) finishes with an
		// exact seek rather than starting from the same key frame again.
		const keyFrame = keyFrameFirst && !continuing;
		const frame = keyFrame
			? await this.seekToKeyFrame({ sinkData, time })
			: await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return {
			frame,
			approximate: !!frame && keyFrame && !this.isFrameValid({ frame, time }),
		};
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: DecodedFrame;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
		isCurrent,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
		isCurrent: () => boolean;
	}): Promise<DecodedFrame | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// A newer request wants another time: show what is decoded so far.
				if (!isCurrent() && sinkData.currentFrame) return sinkData.currentFrame;
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<DecodedFrame | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.frames(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	/** Starts decoding at the key frame before `time` and returns that frame. */
	private async seekToKeyFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<DecodedFrame | null> {
		const key = await sinkData.packets
			.getKeyPacket(time, { verifyKeyPackets: true })
			.catch(() => null);
		return this.seekToTime({ sinkData, time: key?.timestamp ?? time });
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	private async ensureSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: MediaData;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, file });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(mediaId);
		}
	}
	private async initializeSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: MediaData;
	}): Promise<void> {
		const input = new Input({
			source: createMediaSource({ data: file, signal: this.signal }),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const sinkData: VideoSinkData = {
				input,
				frames: frameSource({
					track: videoTrack,
					admit: (frame) => this.admit({ sinkData, frame }),
				}),
				open: [],
				packets: new EncodedPacketSink(videoTrack),
				refining: null,
				requestedAt: 0,
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				lastTime: -1,
				prefetching: false,
				prefetchPromise: null,
			};
			this.sinks.set(mediaId, sinkData);
		} catch (error) {
			input.dispose();
			if (this.signal?.aborted) throw error;
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			sinkData.input.dispose();
			for (const frame of sinkData.open.splice(0)) this.retire(frame);
			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
		this.frameChain.delete(mediaId);
		this.seekGenerations.delete(mediaId);
	}

	clearAll(): void {
		for (const [mediaId] of this.sinks) {
			this.clearVideo({ mediaId });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
