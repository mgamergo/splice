import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	NullTarget,
	StreamTarget,
	type StreamTargetChunk,
	CanvasSource,
	AudioBufferSource,
	canEncodeVideo,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
	type VideoCodec,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { EXPORT_SAMPLE_RATE } from "@/media/audio";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { createCanvasSurface } from "./canvas-utils";
import type { TCanvasSize } from "@/project/types";
import { CanvasRenderer } from "./canvas-renderer";
import { writeOutput } from "./export-output";
import { VideoCache } from "@/services/video-cache/service";

type ExportParams = {
	width: number;
	height: number;
	outputSize?: TCanvasSize;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBlocks?: AsyncIterable<{ buffer: AudioBuffer; time: number }>;
	/**
	 * Where the file goes as it renders. Without one, the export resolves
	 * with the whole file in memory.
	 */
	stream?: WritableStream<StreamTargetChunk>;
	/** False keeps to the browser's default encoder; see `chooseEncoder`. */
	hardwareEncoder?: boolean;
	/** Cancels the export, along with any video read it is waiting on. */
	signal: AbortSignal;
};

/**
 * An encoder failed during an export. The browser's own message ("Encoding
 * error.") doesn't say which encoder it was; this does.
 */
export class ExportEncoderError extends Error {
	readonly track: "video" | "audio";
	readonly encoder: EncoderChoice;

	constructor({
		track,
		encoder,
		cause,
	}: {
		track: "video" | "audio";
		encoder: EncoderChoice;
		cause: unknown;
	}) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			`The ${track} encoder${track === "video" && encoder === "hardware" ? " on the GPU" : ""} failed: ${reason}`,
			{ cause },
		);
		this.track = track;
		this.encoder = encoder;
	}
}

/** What an export produced: the file, or confirmation it went to the stream. */
export type ExportedVideo =
	| { buffer: ArrayBuffer; encoder: EncoderChoice }
	| { streamed: true; encoder: EncoderChoice };

/** Whether the video encoder was asked to use the GPU's media engine. */
export type EncoderChoice = "hardware" | "default";

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

/** Writes to `splice` in pieces large enough that request overhead doesn't matter. */
const STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

/** How often progress is reported; every frame would re-render the dialog 30 times a second. */
const PROGRESS_INTERVAL_MS = 200;

export type SequenceExporterEvents = {
	progress: [progress: number];
	complete: [];
	error: [error: Error];
	cancelled: [];
};

/**
 * Prefers the GPU's encoder (NVENC, AMF, Quick Sync), which is several times
 * faster than software encoding and leaves the CPU to decode and composite.
 * Windows can report a hardware encoder that then fails on the first frame,
 * so it encodes two frames from the export's own canvas first, and keeps to
 * the browser's default where that fails.
 */
async function chooseEncoder({
	canvas,
	codec,
	bitrate,
}: {
	canvas: HTMLCanvasElement | OffscreenCanvas;
	codec: VideoCodec;
	bitrate: (typeof qualityMap)[ExportQuality];
}): Promise<EncoderChoice> {
	try {
		if (
			!(await canEncodeVideo(codec, {
				width: canvas.width,
				height: canvas.height,
				bitrate,
				hardwareAcceleration: "prefer-hardware",
			}))
		)
			return "default";
		const probe = new Output({
			format: new Mp4OutputFormat(),
			target: new NullTarget(),
		});
		const source = new CanvasSource(canvas, {
			codec,
			bitrate,
			hardwareAcceleration: "prefer-hardware",
		});
		probe.addVideoTrack(source, { frameRate: 30 });
		try {
			await probe.start();
			await source.add(0, 1 / 30);
			await source.add(1 / 30, 1 / 30);
			source.close();
			await probe.finalize();
		} catch (error) {
			if (probe.state === "started") await probe.cancel();
			throw error;
		}
		return "hardware";
	} catch (error) {
		console.warn("The GPU video encoder failed a test encode; using the default:", error);
		return "default";
	}
}

export class SequenceExporter extends EventEmitter<SequenceExporterEvents> {
	private renderer: CanvasRenderer;
	private outputSize?: TCanvasSize;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBlocks?: ExportParams["audioBlocks"];
	private stream?: WritableStream<StreamTargetChunk>;
	private hardwareEncoder: boolean;
	private signal: AbortSignal;

	constructor({
		width,
		height,
		outputSize,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBlocks,
		stream,
		hardwareEncoder = true,
		signal,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
			// Its own decoders: the preview, still live during export, would
			// otherwise move them between the clips export is reading.
			videoCache: new VideoCache({ signal }),
		});

		if (
			outputSize &&
			(outputSize.width !== width || outputSize.height !== height)
		)
			this.outputSize = outputSize;
		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBlocks = audioBlocks;
		this.stream = stream;
		this.hardwareEncoder = hardwareEncoder;
		this.signal = signal;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ExportedVideo | null> {
		try {
			return await this.render({ rootNode });
		} finally {
			this.renderer.videoCache.clearAll();
		}
	}

	private async render({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ExportedVideo | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);
		const durationSeconds = frameCount / fpsFloat;
		const audioCodec = this.shouldIncludeAudio && this.audioBlocks
			? await this.chooseAudioCodec()
			: null;

		// Reserving room for the index at the front gives a file that starts
		// playing before it has downloaded, written in one pass and never held
		// whole: the muxer fills the index in once the last frame is written.
		const outputFormat =
			this.format === "webm"
				? new WebMOutputFormat()
				: new Mp4OutputFormat({ fastStart: "reserve" });
		const output = new Output({
			format: outputFormat,
			target: this.stream
				? new StreamTarget(this.stream, {
						chunked: true,
						chunkSize: STREAM_CHUNK_BYTES,
					})
				: new BufferTarget(),
		});

		const outputCanvas = this.renderer.getOutputCanvas();
		// The encoder reads a 2D canvas each frame is copied into, never the
		// compositor's WebGPU canvas: on Windows a frame taken from a WebGPU
		// canvas is in a GPU-only format the encoders refuse ("Unexpected frame
		// format"). The copy stays on the GPU, and also scales to the delivery
		// size where that differs.
		const encoded = createCanvasSurface(
			this.outputSize ?? { width: this.renderer.width, height: this.renderer.height },
		);
		// Keep the saved composition's aspect ratio on legacy custom canvases.
		const scale = Math.min(
			encoded.canvas.width / this.renderer.width,
			encoded.canvas.height / this.renderer.height,
		);
		const width = this.renderer.width * scale;
		const height = this.renderer.height * scale;
		const drawEncoded = () => {
			const { canvas, context } = encoded;
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(
				outputCanvas,
				(canvas.width - width) / 2,
				(canvas.height - height) / 2,
				width,
				height,
			);
		};
		const codec: VideoCodec = this.format === "webm" ? "vp9" : "avc";
		const bitrate = qualityMap[this.quality];
		if (this.hardwareEncoder) {
			// The test encode reads the canvas, so give it the first frame.
			await this.renderer.render({ node: rootNode, time: 0 });
			drawEncoded();
		}
		const encoder = this.hardwareEncoder
			? await chooseEncoder({
					canvas: encoded.canvas,
					codec,
					bitrate,
				})
			: "default";
		const videoSource = new CanvasSource(encoded.canvas, {
			codec,
			bitrate,
			...(encoder === "hardware" && { hardwareAcceleration: "prefer-hardware" }),
		});

		output.addVideoTrack(videoSource, {
			frameRate: fpsFloat,
			maximumPacketCount: frameCount + 1,
		});

		let audioSource: AudioBufferSource | null = null;
		if (audioCodec) {
			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			// AAC frames hold 1024 samples and Opus 20 ms; the margin covers
			// encoder priming and the last partial frame.
			const packetSeconds =
				audioCodec === "aac" ? 1024 / EXPORT_SAMPLE_RATE : 0.02;
			output.addAudioTrack(audioSource, {
				maximumPacketCount: Math.ceil(durationSeconds / packetSeconds) + 64,
			});
		}

		return writeOutput({
			output,
			write: async () => {
				await output.start();

				const blocks = audioSource
					? this.audioBlocks?.[Symbol.asyncIterator]()
					: undefined;
				// The next second of audio decodes while frames render.
				let nextBlock = blocks?.next();
				let audioUntil = blocks ? 0 : Infinity;
				const addAudioUntil = async (seconds: number) => {
					while (nextBlock && audioSource && seconds >= audioUntil) {
						const block = await nextBlock;
						if (block.done) {
							nextBlock = undefined;
							audioSource.close();
							audioUntil = Infinity;
							return;
						}
						nextBlock = blocks!.next();
						await audioSource.add(block.value.buffer).catch((cause: unknown) => {
							throw new ExportEncoderError({ track: "audio", encoder, cause });
						});
						audioUntil = block.value.time + block.value.buffer.duration;
					}
				};
				const cancel = async () => {
					await output.cancel();
					this.emit("cancelled");
					return null;
				};

				let encoding: Promise<void> | null = null;
				let reportedAt = 0;
				try {
					for (let i = 0; i < frameCount; i++) {
						if (this.signal.aborted) return await cancel();

						const timeTicks = i * ticksPerFrame;
						const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
						await addAudioUntil(timeSeconds);
						// Renders this frame while the encoder takes the last one.
						await this.renderer.render({ node: rootNode, time: timeTicks });
						// Copied while the WebGPU canvas still holds this frame. The
						// last frame was captured when it was added, so the copy
						// can't change what the encoder is taking.
						drawEncoded();
						await encoding;
						// The canvas is captured before `add` returns, so the next
						// frame can draw over it straight away.
						encoding = videoSource
							.add(timeSeconds, 1 / fpsFloat)
							.catch((cause: unknown) => {
								throw new ExportEncoderError({ track: "video", encoder, cause });
							});

						const now = performance.now();
						if (now - reportedAt >= PROGRESS_INTERVAL_MS) {
							reportedAt = now;
							this.emit("progress", i / frameCount);
						}
					}
					await encoding;

					if (this.signal.aborted) return await cancel();

					await addAudioUntil(Infinity);
					videoSource.close();
					await output.finalize();
					this.emit("progress", 1);
					this.emit("complete");

					if (this.stream) return { streamed: true, encoder };
					const buffer =
						output.target instanceof BufferTarget ? output.target.buffer : null;
					if (!buffer) {
						this.emit("error", new Error("Failed to export video"));
						return null;
					}
					return { buffer, encoder };
				} finally {
					// A failed frame leaves its encode unobserved; the output is cancelled anyway.
					encoding?.catch(() => {});
					await blocks?.return?.();
				}
			},
		});
	}

	private async chooseAudioCodec(): Promise<"aac" | "opus"> {
		if (this.format === "webm" || typeof AudioEncoder === "undefined")
			return this.format === "webm" ? "opus" : "aac";
		const { supported } = await AudioEncoder.isConfigSupported({
			codec: "mp4a.40.2",
			sampleRate: EXPORT_SAMPLE_RATE,
			numberOfChannels: 2,
			bitrate: 192000,
		});
		return supported ? "aac" : "opus";
	}
}
