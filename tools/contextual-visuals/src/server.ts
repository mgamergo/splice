import { renderMp4 } from "./export";
import {
  editSchema,
  graphicsOverlap,
  resolveVisuals,
  sampleSchema,
} from "./model";

const fromRoot = (path: string) =>
  new URL(`../${path}`, import.meta.url).pathname;
const source = fromRoot("media/interview.mp4");
const sourceFile = Bun.file(source);
if (!(await sourceFile.exists()))
  throw new Error("Run bun run prepare:media first.");
const sample = sampleSchema.parse(
  await Bun.file(fromRoot("fixtures/analysis.json")).json(),
);
if (
  new Set(sample.drafts.map(({ cue }) => cue)).size !== sample.drafts.length ||
  sample.drafts.some(
    (draft) => !sample.cues.some((cue) => cue.id === draft.cue),
  )
) {
  throw new Error("Analysis must reference three different transcript cues.");
}
const result = await Bun.build({
  entrypoints: [fromRoot("src/app.tsx")],
  minify: true,
});
const script = result.outputs[0];
if (!result.success || !script) throw new Error("Browser build failed.");

const stamp = (time: number) =>
  new Date(Math.round(time * 1000)).toISOString().slice(11, 23);
const captions = `${["WEBVTT", ...sample.cues.map((cue) => `${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`)].join("\n\n")}\n`;

let rendering = false;
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4173),
  maxRequestBodySize: 4096,
  idleTimeout: 120,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      switch (path) {
        case "/":
          return new Response(Bun.file(fromRoot("index.html")));
        case "/style.css":
          return new Response(Bun.file(fromRoot("src/style.css")));
        case "/app.js":
          return new Response(script, {
            headers: { "Content-Type": "application/javascript" },
          });
        case "/media/interview.mp4":
          return serveVideo(request, sourceFile);
        case "/media/captions.vtt":
          return new Response(captions, {
            headers: { "Content-Type": "text/vtt; charset=utf-8" },
          });
        case "/api/transcript":
          return Response.json({ cues: sample.cues });
        case "/api/suggest":
          return Response.json(sample);
      }
    }
    if (request.method === "POST" && path === "/api/export") {
      const result = editSchema.safeParse(
        await request.json().catch(() => undefined),
      );
      if (!result.success)
        return Response.json(
          { error: "Check the trim and visual timing." },
          { status: 400 },
        );
      const { trim, visuals } = result.data;
      const resolved = resolveVisuals(sample.drafts, visuals);
      if (resolved.length !== visuals.length)
        return Response.json({ error: "Unknown visual." }, { status: 400 });
      if (graphicsOverlap(resolved)) {
        return Response.json(
          { error: "Move the graphics so they do not overlap." },
          { status: 400 },
        );
      }
      if (rendering)
        return Response.json(
          {
            error: "An export is already running. Try again when it finishes.",
          },
          { status: 409 },
        );
      rendering = true;
      try {
        const output = await renderMp4(source, trim, resolved);
        return new Response(output, {
          headers: {
            "Content-Type": "video/mp4",
            "Content-Disposition":
              'attachment; filename="splice-contextual-demo.mp4"',
            "Cache-Control": "no-store",
          },
        });
      } catch (error) {
        console.error("Export failed", error);
        return Response.json(
          { error: "The devbox could not render this edit." },
          { status: 500 },
        );
      } finally {
        rendering = false;
      }
    }
    return new Response("Page not found.", { status: 404 });
  },
});

function serveVideo(request: Request, file: Bun.BunFile) {
  const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
  const range = request.headers.get("Range");
  if (!range) return new Response(file, { headers });
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = Number(match?.[1]);
  const end = match?.[2]
    ? Math.min(Number(match[2]), file.size - 1)
    : file.size - 1;
  if (!match || start >= file.size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${file.size}` },
    });
  }
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${file.size}`,
    },
  });
}
