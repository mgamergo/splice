import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { duration, sampleSchema } from "../src/model";

const sample = sampleSchema.parse(
  await Bun.file("fixtures/analysis.json").json(),
);
const diagnostics: string[] = [];
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
});
await mkdir("artifacts", { recursive: true });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);
    page.on("console", (msg) => {
      if (msg.type() === "error") diagnostics.push(msg.text());
    });
    page.on("pageerror", (error) => diagnostics.push(error.message));
    page.on("requestfailed", (request) => {
      const message = request.failure()?.errorText;
      // Chromium cancels its previous range request when playback jumps to a new byte offset.
      if (
        message === "net::ERR_ABORTED" &&
        request.url().endsWith("/media/interview.mp4")
      )
        return;
      diagnostics.push(`${message} ${request.url()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        diagnostics.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(appUrl);
    await page.waitForFunction(() => {
      const video = document.querySelector("video");
      return video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(
      () => (document.querySelector("video")?.currentTime ?? 0) > 0.3,
    );
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Suggest visuals" }).click();
    await page.locator("article").nth(2).waitFor();
    assert.equal(await page.locator("article").count(), 3);
    assert.equal(await page.locator(".track button").count(), 0);
    const flow = page.locator("article.flow");
    const before = await jump(page, flow);
    await flow.getByRole("button", { name: "Add to timeline" }).click();
    assert.equal(await page.locator(".track button").count(), 1);
    const after = await jump(page, flow);
    assert.ok(
      difference(before.accent, after.accent) > 60,
      "Adding a graphic changes the preview pixel",
    );
    assert.ok(
      Math.abs((after.accent[0] ?? 0) - 224) < 10,
      "The expected animated accent is visible",
    );
    assert.deepEqual(before.subtitleArea, after.subtitleArea);
    await flow.getByRole("button", { name: "Remove" }).click();
    assert.equal(await page.locator(".track button").count(), 0);
    await page.getByRole("button", { name: "Add all" }).click();
    assert.equal(await page.locator(".track button").count(), 3);

    const trim = 5;
    const flowDraft = sample.drafts.find((draft) => draft.kind === "flow");
    const anchor = sample.cues.find(({ id }) => id === flowDraft?.cue);
    assert.ok(anchor);
    await page.getByLabel("Trim opening").selectOption(String(trim));
    assert.equal(await page.locator(".track button").count(), 3);
    await page.getByLabel("Trim opening").selectOption("20");
    assert.equal(await page.locator(".track button").count(), 2);
    await page.getByLabel("Trim opening").selectOption(String(trim));
    assert.equal(await page.locator(".track button").count(), 3);
    const startInput = flow.getByLabel("Start time for", { exact: false });
    assert.ok(
      Math.abs(Number(await startInput.inputValue()) - (anchor.start - trim)) <
        0.075,
    );
    const phraseStart = page
      .locator("article.label")
      .getByLabel("Start time for", { exact: false });
    const previousPhraseStart = await phraseStart.inputValue();
    await phraseStart.fill(String(anchor.start - trim));
    await phraseStart.blur();
    assert.match(
      (await page
        .getByRole("status", { name: "", exact: true })
        .textContent()) ?? "",
      /do not overlap/,
    );
    assert.equal(await phraseStart.inputValue(), previousPhraseStart);
    await phraseStart.fill("14");
    const trimSelect = page.getByLabel("Trim opening");
    await trimSelect.selectOption("20");
    assert.equal(await page.locator(".track button").count(), 1);
    await startInput.fill("1");
    assert.equal(await startInput.inputValue(), "1");
    await trimSelect.selectOption(String(trim));
    assert.equal(await trimSelect.inputValue(), "20");
    assert.match(
      (await page
        .getByRole("status", { name: "", exact: true })
        .textContent()) ?? "",
      /before restoring/,
    );
    await startInput.fill(String(anchor.start - 20));
    await trimSelect.selectOption(String(trim));
    assert.equal(await page.locator(".track button").count(), 3);
    await phraseStart.fill(previousPhraseStart);

    const newSequenceStart = Math.round((anchor.start - trim - 0.5) * 10) / 10;
    await startInput.fill(String(newSequenceStart));
    await startInput.blur();
    assert.equal(Number(await startInput.inputValue()), newSequenceStart);
    const reference = await jump(page, flow);
    const actualTime = await page
      .locator("video")
      .evaluate((element) =>
        element instanceof HTMLVideoElement ? element.currentTime : -1,
      );
    assert.ok(Math.abs(actualTime - (newSequenceStart + trim + 0.65)) < 0.1);

    await page
      .getByRole("slider", { name: "Seek timeline" })
      .fill(String(newSequenceStart + trim + 6));
    await page.waitForFunction(() => {
      const video = document.querySelector("video");
      return video && !video.seeking;
    });
    for (const view of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(view);
      await page.waitForFunction(
        () => document.documentElement.scrollWidth <= innerWidth,
      );
      await page.screenshot({
        path: `artifacts/editor-${view.width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Export MP4", exact: true }).click();
    await page
      .getByRole("link", { name: "Download MP4" })
      .waitFor({ timeout: 100_000 });
    const downloaded = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download MP4" }).click();
    const mp4 = "artifacts/splice-contextual-demo.mp4";
    await (await downloaded).saveAs(mp4);
    const probe = Bun.spawnSync([
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,codec_type:format=duration",
      "-of",
      "compact",
      mp4,
    ]);
    assert.equal(probe.exitCode, 0);
    const metadata = probe.stdout.toString();
    assert.match(metadata, /codec_name=h264\|codec_type=video/);
    assert.match(metadata, /codec_name=aac\|codec_type=audio/);
    assert.match(
      metadata,
      new RegExp(`duration=${String(duration - trim)}\\.0+`),
    );
    const seek = String(actualTime - trim);
    const pixel = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-ss",
      seek,
      "-i",
      mp4,
      "-vf",
      "format=rgb24,crop=1:1:38:330",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-",
    ]);
    assert.equal(pixel.exitCode, 0);
    assert.ok(
      pixel.stdout.length === 3 &&
        difference(reference.accent, [...pixel.stdout]) < 50,
      `Export differs from preview: ${reference} vs. ${[...pixel.stdout]}`,
    );
    // Compare a decoded frame with its preview, and a decoded frame before the graphic appears.
    const outside = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-ss",
      String(newSequenceStart - 1),
      "-i",
      mp4,
      "-vf",
      "format=rgb24,crop=1:1:38:330",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-",
    ]);
    assert.equal(outside.exitCode, 0);
    assert.equal(outside.stdout.length, 3);
    assert.ok(difference([...pixel.stdout], [...outside.stdout]) > 70);
    const invalid = await ctx.request.post(
      new URL("/api/export", appUrl).href,
      {
        data: { trim: -5, visuals: [] },
      },
    );
    assert.equal(invalid.status(), 400);
    await page.getByLabel("Trim opening").selectOption("10");
    assert.equal(
      await page.getByRole("link", { name: "Download MP4" }).count(),
      0,
    );
    assert.deepEqual(diagnostics, []);
    console.info(
      "Chromium playback, suggestions, editing, trim, viewport fit, export audio/video, and sampled preview parity passed.",
    );
    console.info(metadata.trim());
  } finally {
    await ctx.close();
  }
} finally {
  await browser.close();
}

async function jump(page: Page, card: ReturnType<Page["locator"]>) {
  await card.getByRole("button", { name: "Jump to", exact: false }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return (
      video &&
      !video.seeking &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    );
  });
  return page.locator("canvas").evaluate(async (canvas) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (!(canvas instanceof HTMLCanvasElement))
      throw new Error("Expected a canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Preview is unavailable");
    return {
      accent: [...ctx.getImageData(38, 330, 1, 1).data].slice(0, 3),
      subtitleArea: [...ctx.getImageData(38, 390, 1, 1).data].slice(0, 3),
    };
  });
}

function difference(first: number[], second: number[]) {
  return first.reduce(
    (total, component, index) =>
      total + Math.abs(component - (second[index] ?? -255)),
    0,
  );
}
