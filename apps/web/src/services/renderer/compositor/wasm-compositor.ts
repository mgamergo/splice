import {
	getCompositorCanvas,
	getLastFrameProfile,
	initCompositor,
	releaseTexture,
	renderFrame,
	resizeCompositor,
	uploadTexture,
} from "opencut-wasm";
import {
	incrementCounter,
	isRenderPerfEnabled,
	recordWasmFrameProfile,
} from "@/diagnostics/render-perf";
import type {
	ExternalTextureDescriptor,
	FrameDescriptor,
	RenderedTextureDescriptor,
	TextureUploadDescriptor,
} from "./types";

/**
 * One slot in the derived-texture cache. The OffscreenCanvas is persistent —
 * we reuse and redraw into it across frames, which is the change that takes
 * the WebGL upload path off the per-frame critical path for static content.
 */
type RenderedCacheEntry = {
	kind: "rendered";
	canvas: OffscreenCanvas;
	contentHash: string;
	width: number;
	height: number;
};

type ExternalCacheEntry = {
	kind: "external";
	source: CanvasImageSource;
	width: number;
	height: number;
};

class WasmCompositor {
	private canvas: HTMLCanvasElement | null = null;
	private initializedSize: { width: number; height: number } | null = null;
	private cache = new Map<string, RenderedCacheEntry | ExternalCacheEntry>();
	private framesRendered = 0;
	/** Whether the GPU backend takes VideoFrames and bitmaps as they are. */
	private directUploads = true;
	/** Canvases that sources the GPU can't take are drawn into, reused per texture. */
	private uploadCanvases = new Map<string, OffscreenCanvas>();

	ensureInitialized({ width, height }: { width: number; height: number }) {
		if (!this.canvas) {
			initCompositor(width, height);
			this.canvas = getCompositorCanvas();
			this.initializedSize = { width, height };
			return;
		}

		if (
			!this.initializedSize ||
			this.initializedSize.width !== width ||
			this.initializedSize.height !== height
		) {
			resizeCompositor(width, height);
			this.initializedSize = { width, height };
		}
	}

	getCanvas(): HTMLCanvasElement {
		if (!this.canvas) {
			throw new Error("Compositor is not initialized");
		}
		return this.canvas;
	}

	syncTextures(textures: TextureUploadDescriptor[]) {
		const nextIds = new Set(textures.map((texture) => texture.id));
		for (const previousId of this.cache.keys()) {
			if (!nextIds.has(previousId)) {
				releaseTexture(previousId);
				this.cache.delete(previousId);
				this.uploadCanvases.delete(previousId);
			}
		}

		for (const texture of textures) {
			if (texture.kind === "external") {
				this.syncExternalTexture(texture);
			} else {
				this.syncRenderedTexture(texture);
			}
		}
	}

	/** Counts frames drawn to the shared canvas, so a renderer can tell another drew over its frame. */
	getFramesRendered(): number {
		return this.framesRendered;
	}

	render(frame: FrameDescriptor) {
		renderFrame(frame);
		this.framesRendered++;
		if (isRenderPerfEnabled()) {
			recordWasmFrameProfile(
				getLastFrameProfile() as Array<{ name: string; durationMs: number }>,
			);
		}
	}

	private syncExternalTexture(texture: ExternalTextureDescriptor) {
		const previous = this.cache.get(texture.id);
		if (
			previous?.kind === "external" &&
			previous.source === texture.source &&
			previous.width === texture.width &&
			previous.height === texture.height
		) {
			incrementCounter({ name: "textureCacheHit" });
			return;
		}

		const { source } = texture;
		// A frame a later read already moved past is closed; the texture keeps
		// its last upload rather than failing the whole frame.
		if (isClosedVideoFrame(source)) return;

		incrementCounter({ name: "textureUpload" });
		incrementCounter({
			name: "textureUploadPixels",
			by: texture.width * texture.height,
		});
		if (isDirectSource(source) && this.directUploads) {
			try {
				uploadTexture({
					id: texture.id,
					source,
					width: texture.width,
					height: texture.height,
				});
				this.cache.set(texture.id, {
					kind: "external",
					source,
					width: texture.width,
					height: texture.height,
				});
				return;
			} catch (error) {
				// WebGL can't copy video frames; draw them into a canvas from now on.
				console.warn("Uploading video frames directly failed:", error);
				this.directUploads = false;
			}
		}
		uploadTexture({
			id: texture.id,
			source: this.uploadCanvas({
				id: texture.id,
				source,
				width: texture.width,
				height: texture.height,
			}),
			width: texture.width,
			height: texture.height,
		});
		this.cache.set(texture.id, {
			kind: "external",
			source: texture.source,
			width: texture.width,
			height: texture.height,
		});
	}

	private uploadCanvas({
		id,
		source,
		width,
		height,
	}: {
		id: string;
		source: CanvasImageSource;
		width: number;
		height: number;
	}): OffscreenCanvas {
		if (source instanceof OffscreenCanvas) return source;
		let canvas = this.uploadCanvases.get(id);
		if (!canvas || canvas.width !== width || canvas.height !== height) {
			canvas = createBackingCanvas({ width, height });
			this.uploadCanvases.set(id, canvas);
		}
		const context = canvas.getContext("2d");
		if (!context) throw new Error(`Failed to get 2d context for texture upload ${id}`);
		context.clearRect(0, 0, width, height);
		context.drawImage(source, 0, 0, width, height);
		return canvas;
	}

	private syncRenderedTexture(texture: RenderedTextureDescriptor) {
		const previous = this.cache.get(texture.id);
		if (
			previous?.kind === "rendered" &&
			previous.contentHash === texture.contentHash &&
			previous.width === texture.width &&
			previous.height === texture.height
		) {
			incrementCounter({ name: "textureCacheHit" });
			return;
		}

		const canvas =
			previous?.kind === "rendered" &&
			previous.width === texture.width &&
			previous.height === texture.height
				? previous.canvas
				: createBackingCanvas({
						width: texture.width,
						height: texture.height,
					});

		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error(`Failed to get 2d context for texture ${texture.id}`);
		}
		ctx.clearRect(0, 0, texture.width, texture.height);
		texture.draw(ctx);

		incrementCounter({ name: "textureUpload" });
		incrementCounter({
			name: "textureUploadPixels",
			by: texture.width * texture.height,
		});
		uploadTexture({
			id: texture.id,
			source: canvas,
			width: texture.width,
			height: texture.height,
		});
		this.cache.set(texture.id, {
			kind: "rendered",
			canvas,
			contentHash: texture.contentHash,
			width: texture.width,
			height: texture.height,
		});
	}
}

export const wasmCompositor = new WasmCompositor();

function createBackingCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas {
	if (typeof OffscreenCanvas === "undefined") {
		throw new Error("OffscreenCanvas is not supported in this environment");
	}
	return new OffscreenCanvas(width, height);
}

/** Sources the GPU copies as they are, without drawing them into a canvas. */
function isDirectSource(
	source: CanvasImageSource,
): source is VideoFrame | ImageBitmap | OffscreenCanvas {
	return (
		(typeof VideoFrame !== "undefined" && source instanceof VideoFrame) ||
		(typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) ||
		(typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)
	);
}

/**
 * A closed VideoFrame reports no size; copying from it would throw inside
 * the GPU core. (Its format is null too, but so is a valid hardware frame's.)
 */
function isClosedVideoFrame(source: CanvasImageSource): boolean {
	return (
		typeof VideoFrame !== "undefined" &&
		source instanceof VideoFrame &&
		source.codedWidth === 0
	);
}
