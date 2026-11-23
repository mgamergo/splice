import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import {
  attribution,
  duration,
  FPS,
  HEIGHT,
  type Visual,
  WIDTH,
} from "./model";
import { animate } from "./paint";

export async function renderMp4(
  source: string,
  trim: number,
  visuals: Visual[],
) {
  const folder = await mkdtemp(join(tmpdir(), "splice-render-"));
  const output = join(folder, "video.mp4");
  const length = String(duration - trim);
  const decoder = spawn(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-threads",
      "2",
      "-ss",
      String(trim),
      "-i",
      source,
      "-t",
      length,
      "-an",
      "-vf",
      `fps=${FPS}`,
      "-pix_fmt",
      "rgba",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const encoder = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${WIDTH}x${HEIGHT}`,
      "-framerate",
      String(FPS),
      "-i",
      "pipe:0",
      "-ss",
      String(trim),
      "-i",
      source,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      length,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-metadata",
      "comment=Adapted by Splice from " +
        attribution.title +
        " by " +
        attribution.creators +
        ". Source: " +
        attribution.source +
        ". CC BY 4.0: " +
        attribution.license,
      output,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  const decoderClosed = once(decoder, "close");
  const encoderClosed = once(encoder, "close");
  const rendered = pipeline(
    Readable.from(renderFrames(decoder.stdout, trim, visuals)),
    encoder.stdin,
  );
  try {
    const [[decoded], [encoded]] = await Promise.all([
      decoderClosed,
      encoderClosed,
      rendered,
    ]);
    if (decoded !== 0 || encoded !== 0)
      throw new Error("Video encoding failed.");
    return await Bun.file(output).arrayBuffer();
  } finally {
    decoder.kill();
    encoder.kill();
    await Promise.allSettled([decoderClosed, encoderClosed, rendered]);
    await rm(folder, { recursive: true, force: true });
  }
}

async function* renderFrames(input: Readable, trim: number, visuals: Visual[]) {
  const bytes = WIDTH * HEIGHT * 4;
  const raw = new Uint8ClampedArray(bytes);
  const inputFrame = createCanvas(WIDTH, HEIGHT);
  const outputFrame = createCanvas(WIDTH, HEIGHT);
  const source = inputFrame.getContext("2d");
  const output = outputFrame.getContext("2d");
  let filled = 0;
  let frame = 0;
  for await (const untyped of input) {
    if (!Buffer.isBuffer(untyped))
      throw new Error("Expected a raw video frame.");
    let offset = 0;
    while (offset < untyped.length) {
      const available = Math.min(bytes - filled, untyped.length - offset);
      raw.set(untyped.subarray(offset, offset + available), filled);
      offset += available;
      filled += available;
      if (filled !== bytes) continue;
      source.putImageData(new ImageData(raw, WIDTH, HEIGHT), 0, 0);
      animate(
        output,
        (x, y, width, height) =>
          output.drawImage(inputFrame, x, y, width, height),
        visuals,
        trim + frame / FPS,
      );
      yield Buffer.from(output.getImageData(0, 0, WIDTH, HEIGHT).data.buffer);
      filled = 0;
      frame++;
    }
  }
  if (filled !== 0 || frame !== (duration - trim) * FPS) {
    throw new Error("Decoded frame count differs from the requested duration.");
  }
}
