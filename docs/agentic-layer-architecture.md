# Splice: architecture for an agent-driven video editor

**Status:** proposal · **Date:** 2026-11-22 · **Baseline analysed:** `github.com/mgamergo/splice` (fork of OpenCut)

## 1. Goal

An AI agent should be able to edit a video in Splice by itself: import media, cut, trim,
arrange, caption, add text and graphics, animate, mix audio, and export. It should handle the
basics and a set of advanced operations. The agent talks to the editor through a protocol layer
(MCP first). A human can watch the edit happen live, step in, and undo anything the agent did.

This document covers:

1. what the fork actually contains today (§2),
2. which code to use as the baseline (§3),
3. the architecture of the agent communication layer (§4–§8),
4. the work needed, in phases (§9), and
5. risks and open questions (§10).

---

## 2. What the fork contains

I cloned the fork onto a fresh boxes.dev devbox (`splice` project, instance `ac99b60d…`) and
compared it with both upstream OpenCut repositories.

| Code | Commit | What it is |
|---|---|---|
| `mgamergo/splice` `main` | `e6680107` (2026-09-24) | **Byte-identical to upstream `OpenCut-app/OpenCut` main.** That repo is the *rewrite*: a moon/proto monorepo with a GPUI (Rust) desktop shell, a TanStack Start web app holding only a stub `/editor` route plus the shadcn UI kit, an Elysia "hello world" API on Cloudflare Workers, and an FFmpeg build script. About **2.5k lines**, not counting the UI kit. There is **no timeline, no renderer, no media pipeline and no project model.** |
| `mgamergo/splice` @ `d6622dc6` (2026-05-02) | parent of `b3d35fbc chore: clean state` | The last full editor in the fork's own history. `b3d35fbc` deleted 1,104 files (131k lines). |
| `opencut-app/opencut-classic` `main` | `cf5e79e` (2026-05-17) | The same editor, about two weeks newer than `d6622dc6`: a Next.js 16 + React 19 web editor (≈91k lines of TS/TSX in `apps/web/src`) with Rust→WASM crates for time, compositing, effects, masks and the GPU path. This is what opencut.app runs today. |

The upstream README states the plan for the rewrite: *"An Editor API… MCP server (for AI
agents)… Headless mode… A scripting tab"*. It also says outside contributions are closed while
the architecture is being designed. None of it exists yet.

### 2.1 The classic engine (the part that matters)

Everything below lives in `opencut-classic/apps/web/src`.

**`EditorCore`** (`core/index.ts`) is a singleton that owns 12 managers:
`timeline`, `command`, `playback`, `scenes`, `project`, `media`, `renderer`, `save`, `audio`,
`selection`, `clipboard`, `diagnostics`. Each manager exposes plain methods plus `subscribe()`.
React reads them through hooks, but **the managers themselves do not depend on React.** That is
the most important property for an agent layer.

**Command pattern with undo/redo** (`commands/`, `core/managers/commands.ts`):

- `Command` has `execute() / undo() / redo()` and returns an optional selection patch.
- `BatchCommand` runs several commands as **one undo step**.
- `CommandManager.execute()` handles history, ripple-editing adjustments, selection restore and
  post-command "reactors" (for example, pruning empty tracks).
- There are **40 concrete commands**: insert/move/split/delete/duplicate/update elements, trim,
  retime, track add/remove/mute/hide, effects (add/remove/reorder/toggle/params), keyframes
  (upsert/remove/retime/curves, effect-param keyframes), masks, scenes, bookmarks, media
  add/remove, and project settings.

**Data model** (`timeline/types.ts`):

- `TProject` → `TScene[]` → `SceneTracks { main: VideoTrack, overlay: OverlayTrack[], audio: AudioTrack[] }`.
- Track types are `video | text | audio | graphic | effect`. Element types are
  `video | image | audio | text | sticker | graphic | effect`.
- Every element has `startTime`, `duration`, `trimStart`, `trimEnd`, `params` (a flat
  `Record<string, number|string|boolean>`, e.g. `transform.positionX`, `opacity`, `volume`,
  `content`, `fontSize`), optional `animations` (keyframes), `effects`, `masks` and `retime`.
- Time is **`MediaTime`**: a branded integer tick count computed in Rust/WASM
  (`TICKS_PER_SECOND`, frame rounding, timecode parsing).

**Actions** (`actions/definitions.ts`) are 36 keyboard-oriented actions (`split`,
`delete-selected`, `toggle-ripple-editing`, …) dispatched through `invokeAction()`. They depend
on the **current selection and playhead**, which makes them a poor fit for an agent API (§5.2).

**Media, rendering, export and AI features:**

- Media decode and encode use `mediabunny` (WebCodecs).
- Preview runs on a WebGPU compositor in WASM, with a Canvas fallback (`renderer.setDegraded`).
- `RendererManager.saveSnapshot()` already produces a PNG of the current frame.
- `SceneExporter` renders MP4/WebM through `CanvasSource` + `AudioBufferSource`, with progress
  events and cancellation.
- `ProjectManager.export()` returns an `ArrayBuffer`.
- Transcription runs Whisper (tiny → large-v3-turbo) in a Web Worker through ONNX.
- `subtitles/` parses and inserts SRT/ASS.
- Projects persist to IndexedDB, and media to OPFS, with a migration runner (v1 → v22+).

**Baseline health (measured on the devbox, bun 1.2.18 as pinned):**

- `bun install` completes.
- `bun test`: **157 pass, 9 fail, 3 errors** across 30 files. The failures are in
  `timeline/placement/__tests__/resolve.test.ts`.
- `tsc --noEmit`: **21 errors**, mostly the `MediaTime` branding drift (`number` not assignable
  to `MediaTime`) plus changelog and keybinding persistence types.
- I did not run the editor in a browser during this analysis.

### 2.2 The constraint that shapes everything

The engine is **browser-native**. It depends on WebCodecs, WebGPU/Canvas/OffscreenCanvas,
AudioContext/AudioBuffer, Web Workers, IndexedDB and OPFS. You cannot `import` it into a Node
MCP server and call `timeline.splitElements()`. **The agent layer has to reach into a live
browser page.** That page is either a human's tab or a headless Chromium the server launches
itself.

---

## 3. Baseline decision

| Option | Pros | Cons |
|---|---|---|
| **A. Restore the classic editor into the fork and build on it** (recommended) | A full editor that works today. A clean command/manager core that suits an API. TypeScript/React, which matches your preferred stack. MIT licence. | It diverges from upstream's rewrite, so upstream fixes won't merge cleanly. There is a known test and type debt (§2.1). Browser-only engine. |
| B. Build on the rewrite (`main`) | It tracks upstream's future: a Rust core, native headless mode, and an MCP server of their own. | Nothing is there to drive. You would be writing the editor before the agent layer, and upstream isn't taking contributions. |
| C. Build on a native editor (MLT/Shotcut, Kdenlive, OpenShot) | Mature engines with real headless rendering (`melt`). | C++/Qt/Python. A different fork from the one you chose. No live web UI. |

**Recommendation: A.** Create a long-lived branch, for example `classic`, from
`opencut-classic@cf5e79e`, or from the fork's own `d6622dc6` if you want to stay inside your
fork's history. Make it Splice's main development line.

To keep a door open to option B, **put the agent layer behind a narrow `EditorApi` interface**
(§5). That interface is the only thing that knows about `EditorCore`. If upstream's Rust core
matures, you write a second `EditorApi` implementation and keep the MCP server, schemas,
prompts and evals unchanged.

---

## 4. Target architecture

```
 ┌───────────────────────────┐      MCP (stdio or Streamable HTTP on 127.0.0.1)
 │ Agent                     │◄──────────────────────────────────────────────┐
 │ Claude Code / Desktop /   │                                               │
 │ any MCP client / in-app   │                                               │
 │ chat panel (phase 3)      │                                               │
 └───────────────────────────┘                                               │
                                                                             ▼
                                                ┌──────────────────────────────────────┐
                                                │ apps/mcp  (Bun, "splice-mcp")        │
                                                │  • MCP tools/resources/prompts       │
                                                │  • zod schemas from packages/api     │
                                                │  • session registry (handles)        │
                                                │  • file bridge (import/export bytes) │
                                                │  • analysis sidecar (ffprobe/ffmpeg) │
                                                │  • headless launcher (Playwright)    │
                                                └───────────────┬──────────────────────┘
                                                                │ WebSocket, JSON-RPC 2.0
                                                                │ 127.0.0.1 + one-time token
                        ┌───────────────────────────────────────┴───────────────────┐
                        ▼                                                           ▼
     ┌────────────────────────────────────┐                  ┌────────────────────────────────────┐
     │ Human's browser tab (attached)     │                  │ Headless Chromium (spawned)         │
     │ /editor/<id>?agent=<token>         │                  │ same URL, launched by apps/mcp      │
     │  apps/web/src/agent/bridge.ts      │                  │  same bridge + same EditorApi       │
     │  apps/web/src/agent/editor-api.ts ─┼─► EditorCore     │                                     │
     └────────────────────────────────────┘    (commands,    └────────────────────────────────────┘
                                                renderer, export, transcription)
```

The main design choices:

1. **The MCP server is a separate process; the editor stays in the browser.** The server is
   protocol glue plus filesystem access. The page is the execution engine. This keeps the 91k-line
   engine unchanged and gives the human a live view for free.
2. **Two attach modes share one code path.**
   - *Attached*: the user opens the editor and clicks "Connect agent", or opens a URL with a
     token. The agent edits while the human watches and can undo.
   - *Headless*: the MCP server launches Chromium through Playwright, for batch jobs, CI and
     evals.

   The bridge protocol is identical in both modes.
3. **The wire protocol inside the system is JSON-RPC 2.0 over WebSocket**, not MCP. MCP is the
   *external* contract. The internal bridge stays small, versioned, and free to change. A
   Chrome-DevTools-Protocol `page.evaluate` bridge was considered and rejected as the main path:
   it works only in headless mode and makes the API stringly typed.
4. **All mutations go through the existing `CommandManager`.** Every agent edit is undoable,
   ripple-aware and saved by `SaveManager`, exactly like a human edit.

### Proposed repo layout (on the `classic` line)

```
packages/
  editor-api/            # shared: zod schemas, operation types, error codes, wire types
apps/
  web/src/agent/
    editor-api.ts        # EditorApi implementation over EditorCore
    digest.ts            # compact timeline serializer for LLMs
    bridge.ts            # WebSocket JSON-RPC client, auth, reconnection
    perception.ts        # frame grabs, contact sheets, waveform/transcript access
    agent-indicator.tsx  # "Agent connected / editing…" UI + kill switch
  mcp/
    src/server.ts        # MCP server (official TS SDK), tool/resource/prompt registration
    src/bridge-host.ts   # WebSocket server, session registry
    src/headless.ts      # Playwright launcher (system Chromium, GPU flags)
    src/files.ts         # path allowlist, chunked upload/download
    src/analysis/        # ffprobe, silence/scene/loudness detection
evals/                   # golden projects + task specs + graders
```

---

## 5. The Editor API layer (inside the web app)

This is where most of the engineering goes. MCP tools are thin wrappers over it.

### 5.1 Shape

```ts
// packages/editor-api — illustrative
interface EditorApi {
  // reads
  getState(opts?: { detail: "digest" | "full" }): TimelineSnapshot;  // includes `revision`
  listMedia(): MediaInfo[];
  // writes: always a list of ops, applied atomically as one BatchCommand = one undo step
  apply(req: { ops: EditOp[]; expectedRevision?: number; label?: string }): ApplyResult;
  undo(n?: number): ApplyResult;  redo(n?: number): ApplyResult;
  // perception
  renderFrame(at: TimeSpec, opts?: { width?: number }): Png;
  contactSheet(range: Range, count: number): Png;
  transcribe(mediaId: string, opts?: { model?: string; language?: string }): Transcript;  // long-running
  // io
  importMedia(file: { name: string; bytes: ArrayBuffer | ReadableStream }): MediaInfo;
  export(opts: ExportOptions): ExportHandle;  // long-running, progress events
}
type EditOp =
  | { op: "insert_clip"; mediaId: string; at: TimeSpec; track?: TrackRef; trim?: Range }
  | { op: "move";   targets: ElementRef[]; to: TimeSpec; track?: TrackRef }
  | { op: "trim";   target: ElementRef; start?: TimeSpec; end?: TimeSpec }
  | { op: "split";  targets: ElementRef[]; at: TimeSpec }
  | { op: "delete"; targets: ElementRef[]; ripple?: boolean }
  | { op: "set_params"; target: ElementRef; params: Record<string, ParamValue> }
  | { op: "keyframe"; target: ElementRef; param: string; at: TimeSpec; value: ParamValue; easing?: Easing }
  | { op: "add_text"; text: string; at: TimeSpec; duration: TimeSpec; style?: TextStyle }
  | { op: "add_effect"; target: ElementRef; effect: string; params?: Record<string, ParamValue> }
  | { op: "retime"; target: ElementRef; rate: number; maintainPitch?: boolean }
  | { op: "track"; action: "add" | "remove" | "mute" | "hide"; ... }
  | /* … one variant per existing Command … */;
type TimeSpec = { seconds: number } | { frame: number } | { timecode: string };
```

### 5.2 Rules for the implementation

- **Explicit targets, never implicit UI state.** Ops name their element and track IDs and their
  times. Do not route through `invokeAction("split")`, which reads the selection and playhead.
  Build the `Command` objects directly. This needs a small refactor so commands receive the
  editor instance instead of calling `EditorCore.getInstance()` inside `execute()` (42 call
  sites).
- **One tool call is one undo step.** Wrap each `apply()` in a `BatchCommand` with a label, for
  example "Agent: remove silences". A human pressing ⌘Z then reverts the agent's whole intent.
- **Optimistic concurrency.** Keep a monotonic `revision` that increments on every command
  (hook `CommandManager.registerReactor`). Agents send `expectedRevision`. If a human edited in
  between, the call fails with `REVISION_CONFLICT` and the fresh digest, and the agent re-plans.
- **Validate before mutating.** Use zod at the boundary, then do semantic checks such as
  "element exists", "track type accepts element" (reuse `timeline/placement`'s
  `canElementGoOnTrack` and `validateElementTrackCompatibility`), and "time inside source
  duration". If any op fails, nothing is applied.
- **Speak seconds, not ticks.** Accept seconds, frames or timecode, and convert through the
  WASM `mediaTimeFromSeconds` / `roundToFrame`. Return times in seconds, rounded to frames.
- **Stable, readable IDs.** Keep the UUIDs internally. The digest can add short aliases
  (`v1.c3` = video track 1, clip 3) that the API resolves, which saves tokens and reduces
  mistakes.
- **Return results the agent can use.** Every write returns new element IDs, the new revision
  and a short diff, for example `"split c3 at 12.40s → c3 (0–12.40), c7 (12.40–20.00)"`.

### 5.3 The timeline digest

An LLM needs a compact, faithful picture of the edit. Its first-class representation is a text
digest like this:

```
project "Promo" 1920x1080 @30fps, duration 00:01:12.10, revision 41
main  v0: [c1 interview.mp4 0.00–18.20 (src 4.00–22.20)] [c2 broll-city.mp4 18.20–24.00] …
over  t1: [x1 text "Hello" 1.00–4.00 pos(0,-320) size 64]
audio a1: [m1 music.mp3 0.00–72.10 vol -12dB fadeout 3s]
media: interview.mp4 (02:10, 1080p, audio), broll-city.mp4 (00:14), music.mp3 (03:20)
markers: 12.40 "best take"
```

`getState({detail:"full"})` returns the full JSON for precise work. Expose the digest as an MCP
resource too, so clients can subscribe to it.

### 5.4 Perception: how the agent sees and hears

An agent that edits blind produces bad cuts. Give it:

| Capability | Source |
|---|---|
| Frame at time t (PNG, downscaled) | `RendererManager.saveSnapshot` path / `CanvasRenderer` |
| Contact sheet (N frames over a range in one image) | new; composite N renders |
| Transcript with word timestamps | existing Whisper worker (`services/transcription`) |
| Waveform / loudness summary | existing `media/waveform-summary.ts`; FFmpeg `ebur128` sidecar for LUFS |
| Silence spans | FFmpeg `silencedetect` sidecar (server side, on the original file) |
| Shot / scene boundaries | FFmpeg `select='gt(scene,0.3)'` sidecar |
| Media probe | `ffprobe` sidecar + `media/media-utils.ts` |

Analysis that works on *source files* runs in the MCP server through FFmpeg. It is faster and
doesn't block the UI. Analysis that depends on the *edited timeline*, such as frames, runs in
the page.

---

## 6. The bridge (MCP server ↔ editor page)

- **Transport:** a WebSocket on `127.0.0.1:<port>`. The page connects *out* to the server.
- **Auth:** the server mints a random one-time token per session. The page receives it through
  the URL fragment (`#agent=…`, so it never reaches server logs) or a "Connect agent" dialog.
  The server rejects any connection whose `Origin` isn't the editor's origin.
- **Protocol:** JSON-RPC 2.0 with methods that mirror `EditorApi` (`editor.apply`,
  `editor.getState`, `editor.renderFrame`, …). Notifications cover `state.changed {revision}`,
  `export.progress`, `transcribe.progress` and `human.interrupt`.
- **Binary payloads:** media import and export can be hundreds of MB, so send them as chunked
  binary frames. In headless mode a simpler alternative is for the server to expose a loopback
  `GET /files/<handle>` that the page `fetch()`es. Store import results in OPFS as the existing
  media pipeline already does.
- **Sessions:** keep a registry keyed by a server-minted `editorSession` handle that every MCP
  tool takes as an argument. This matches the direction of the MCP 2026-07-28 revision, which
  removes protocol-level sessions and says to pass server-minted handles as ordinary arguments.
- **Human-in-the-loop UI:**
  - an "Agent connected" badge,
  - a live label of the current operation,
  - a **Stop agent** button that sends `human.interrupt` and makes the API reject writes until
    the user resumes,
  - an "agent edits" filter in the undo history.

### Headless mode details

- Use Playwright with system Chromium. Run headless by default (`INSTABOX_HEADLESS=1` on this
  infrastructure).
- WebGPU in headless Chromium is not reliable on GPU-less VMs. Start with the **Canvas
  fallback**, which the renderer already supports through `setDegraded`, and treat GPU as an
  optimisation: try `--enable-unsafe-webgpu`, and Vulkan/SwiftShader where it is available.
- WebCodecs H.264 encode needs proprietary codecs. Check what the bundled Chromium supports, and
  fall back to WebM/VP9 or to an FFmpeg remux on the server.
- Persistence: use a fresh browser profile per job. Media comes in through the import API. To
  keep projects, export the project JSON through the API rather than relying on IndexedDB in a
  temporary profile.

---

## 7. The MCP surface

Build on the **official MCP TypeScript SDK** and pin its version. Support **stdio** (Claude
Code, Claude Desktop) and **Streamable HTTP on loopback**. Validate `Origin` and return 403 on a
mismatch, as the spec requires.

The spec is changing. The 2025-11-25 revision added experimental *tasks*. The 2026-07-28
revision moves tasks into an extension, removes `Mcp-Session-Id`, replaces
`resources/subscribe` with `subscriptions/listen`, and swaps server-initiated elicitation for
multi-round-trip `input_required` results. Design for the newer model and let the SDK handle
version negotiation:

- handles as arguments,
- long jobs as tasks with polling,
- progress notifications on the request stream.

### 7.1 Tools

Group them and keep the descriptions tight. Every write tool takes `editorSession` and an
optional `expectedRevision`, and returns `structuredContent` with an `outputSchema`.

| Group | Tools | Level |
|---|---|---|
| Session | `session_open` (attach to a tab or launch headless), `session_close`, `session_status` | basic |
| Project | `project_create`, `project_open`, `project_list`, `project_settings` (canvas size, fps, background) | basic |
| Media | `media_import` (path or URL → mediaId), `media_list`, `media_probe` | basic |
| Read | `timeline_get` (digest/full), `frame_render`, `frames_contact_sheet` | basic |
| Edit | `timeline_apply` (batch of `EditOp`s, the workhorse) plus a few convenience wrappers: `clip_add`, `clip_split`, `clip_trim`, `clip_move`, `clip_delete`, `text_add` | basic |
| History | `undo`, `redo`, `checkpoint_create` / `checkpoint_restore` (snapshot project JSON) | basic |
| Audio | `audio_set_volume`, `audio_fade` (volume keyframes), `audio_detach` (source-audio separation), `audio_normalize` (LUFS target via analysis + gain) | basic/adv |
| Animation & FX | `keyframe_set`, `effect_add`, `effect_update`, `mask_add`, `element_set_params` | advanced |
| Speed | `clip_retime` (rate, maintain pitch) | advanced |
| Analysis | `transcribe` (task), `detect_silence`, `detect_scenes`, `measure_loudness` | advanced |
| Compound | `captions_from_transcript` (style, words per caption), `remove_silences` (threshold, padding), `remove_filler_words`, `rough_cut_from_transcript` (keep ranges), `reframe` (16:9 → 9:16 with transform keyframes), `beat_sync_cuts` | advanced |
| Output | `export` (task with progress; writes to an allow-listed path), `export_cancel` | basic |

Compound tools are *macros* over `timeline_apply`. They live in the MCP server or in
`packages/editor-api`, so they can be tested without a browser against a pure timeline
reducer (§9, phase 1), and each one produces a single undo step.

### 7.2 Resources and prompts

- **Resources:**
  - `splice://session/{id}/timeline` (digest)
  - `…/timeline.json`
  - `…/media`
  - `…/transcript/{mediaId}`
  - `…/frame/{seconds}.png`

  Clients that subscribe get `state.changed`.
- **Prompts:** packaged workflows such as `edit-talking-head`, `make-shorts`,
  `add-captions` and `clean-up-audio`. Each one teaches the agent the house style:
  1. inspect,
  2. plan as an edit decision list,
  3. apply in batches,
  4. verify with frames and the digest,
  5. export.

### 7.3 Possible later option: "code mode"

When workflows involve hundreds of edits, tool-call overhead dominates. Add `run_script`: a
TypeScript snippet executed in the page inside a sandboxed Worker that can see only an
`EditorApi` proxy, with a time limit and op limit, and all ops applied as one batch. This
matches upstream's planned "scripting tab", and the same sandbox can serve both. Ship it only
after the security model (§8) is in place.

---

## 8. Safety and security

- **Network:** bind only to loopback. Use a one-time token. Check `Origin`. Do not publicly
  expose the bridge or the MCP HTTP port.
- **Filesystem:** `media_import` and `export` accept only paths under configured roots
  (`--media-dir`, `--export-dir`). Resolve symlinks and reject `..`. URL imports use an
  allow-list and a size cap.
- **Destructive operations:**
  - Project deletion and overwriting an existing export ask the human first, through an MCP
    elicitation / `input_required` round trip, or an in-editor confirm when attached.
  - Every agent batch is undoable.
  - `checkpoint_create` runs automatically before compound tools.
- **Prompt injection:** treat transcript text, media filenames and metadata as data. Never let
  them become instructions in prompts the server writes.
- **Resource limits:**
  - cap concurrent headless sessions (one by default on a 4 vCPU / 8 GB box),
  - cap export duration and resolution per call,
  - set timeouts on every RPC.

---

## 9. Work plan

### Phase 0: Baseline (≈1 week)

1. Branch `classic` from `opencut-classic@cf5e79e` (or the fork's `d6622dc6`) into the fork.
   Rebrand to Splice. Keep the MIT licence and attribution.
2. Make it green:
   - fix the 9 failing `resolveTrackPlacement` tests and the 21 `tsc` errors (the `MediaTime`
     branding drift),
   - add `typecheck` / `lint` / `test` scripts to CI,
   - pin bun 1.2.18 (the proto shim on the devbox did not pick it up automatically).
3. Add a Playwright smoke E2E: open the editor, import a fixture clip, split it, export, and
   assert the output duration.

### Phase 1: Editor API in the page (≈2–3 weeks)

1. `packages/editor-api`: zod schemas for `EditOp`, `TimeSpec`, results and error codes.
2. Refactor commands to take the editor through their constructor instead of the singleton.
   This makes commands testable without a DOM.
3. Extract a **pure timeline reducer**, `(tracks, op) → tracks`, from the commands. That gives
   compound tools, validation and evals a browser-free path, and it is the piece that would
   later port to Rust.
4. `apps/web/src/agent/editor-api.ts`:
   - `apply` with `BatchCommand` and labels,
   - revision tracking,
   - semantic validation,
   - `getState` with the digest.
5. Unit tests: every `EditOp` against golden projects, undo round-trips, and conflict
   detection.

### Phase 2: Bridge and MCP server (≈2 weeks)

1. `apps/mcp`:
   - the official MCP SDK over stdio and Streamable HTTP,
   - the WebSocket bridge host,
   - the session registry,
   - the file bridge with path allow-listing.
2. Page side: `agent/bridge.ts`, the connect dialog, the agent badge and the **Stop agent**
   switch.
3. Headless launcher: Playwright with system Chromium and the Canvas fallback. Verify that
   export works headless.
4. Basic tools from §7.1, plus resources.
5. End-to-end tests: an MCP client script drives a headless session through import → cut →
   text → export, then checks the output with `ffprobe` and a frame comparison.

### Phase 3: Perception and advanced tools (≈3 weeks)

1. Frame render, contact sheets, and transcription exposed as a task with progress.
2. FFmpeg analysis sidecar: silence, scenes, loudness, probe.
3. Compound tools: captions, silence and filler removal, rough cut from transcript, reframe,
   audio normalise, beat-synced cuts.
4. Prompts (workflow recipes), checkpoints, and confirmation for destructive ops.

### Phase 4: Built-in agent and polish (≈2–3 weeks, optional)

1. An in-editor chat panel. The loop runs server-side in `apps/mcp`, using the Claude API with
   tool use and the **same tool definitions**:
   - default model `claude-opus-5-5`,
   - adaptive thinking,
   - streaming,
   - `strict` tool schemas,
   - automatic `tool_choice` (forced tool choice returns an error on current models).

   Anthropic-hosted Managed Agents would also work, with Splice's tools as custom tools, if you
   would rather not host the loop.
2. `run_script` code mode in a sandboxed Worker.
3. **An eval suite** (`evals/`): about 20 task specs such as "cut silences > 0.7s",
   "add burned-in captions", "make a 30s vertical highlight". Each runs headless and is graded
   on timeline JSON assertions, rendered-frame checks and an LLM-judge rubric. Run it in CI, and
   whenever tools, descriptions or prompts change.

### Definition of done for v1

An MCP client with no special knowledge can:

1. open a headless session,
2. import a 5-minute talking-head clip plus music,
3. remove silences,
4. add styled captions,
5. duck the music under speech,
6. add a title card, and
7. export a 1080p MP4.

The result must be correct in the evals, every step must be visible and undoable in an attached
tab, and the whole run must take less than about 10 minutes of wall time on the devbox.

---

## 10. Risks and open questions

| Risk | Mitigation |
|---|---|
| Diverging from upstream OpenCut (a rewrite in Rust) | The `EditorApi` boundary plus the pure reducer. Watch upstream's Editor API/MCP design and align the op vocabulary where it makes sense. |
| Headless WebGPU/WebCodecs gaps on cloud VMs | Canvas fallback, WebM fallback, FFmpeg remux. Test early (phase 2, step 3). |
| Large media through the bridge | Loopback file endpoint or chunked frames. Never base64 video into MCP messages. |
| Agent edits racing human edits | Revisions with `expectedRevision`, the Stop switch, one undo step per batch. |
| MCP spec churn (2025-11-25 → 2026-07-28) | Pin the SDK, design around handles and tasks, and keep the protocol details in `apps/mcp` only. |
| Effect library is thin (blur only; no transitions) | Plan transitions (cross-dissolve, dip-to-black) and colour/LUT effects as engine work in phase 3+. The agent layer can't expose what the engine lacks. |

**Decisions taken (2026-11-22):**

- **Baseline:** restore the classic editor from `opencut-classic@cf5e79e`. It is newer than the fork's
  `d6622dc6`. Shotcut, Kdenlive and Blender were reviewed as alternatives and rejected (see §11).
- **Primary mode:** *attached*. The agent edits a live tab in Chrome on the user's laptop
  (Ryzen 7, 24 GB, RTX 5050), with hardware WebGPU and WebCodecs. The user watches in real time.
  Headless mode becomes optional and is useful mainly for evals.
- **Workload:** one video at a time, two at most. The agent does the rough cut (trims, silence
  and retake removal, matching voice to video, audio sync). The human finishes the edit by
  adding memes, overlays and text.
- **Engine work this implies:** transitions, more effects, GIF/WebP sticker support and audio
  ducking. These move into phases 1–3 alongside the agent layer.

**Still open:**

1. Should `main` in the fork become the classic line, or stay mirrored to upstream's rewrite?
2. Primary agent host: external MCP clients only, or the built-in chat panel too (phase 4)?

## 11. Alternatives considered for live agent editing

| Editor | Live agent control | Why not chosen |
|---|---|---|
| Shotcut (MLT XML) | None. The agent can only write project files, and an open project does not reload. | Can't show the agent editing in real time. |
| Kdenlive | Only through community forks that add D-Bus or WebSocket APIs. | You'd maintain a patched C++/Qt/KDE fork outside your stack, and it's unclear whether agent edits join Kdenlive's undo history. |
| Blender VSE | Full Python API, live, no fork needed. | Its editing UX and long-form playback are weaker for fast finishing work, and it's a 3D suite rather than a video editor. Runner-up. |
| WeftCut | Built-in MCP. | Launched around Sept/Oct 2026 with about 19 stars. Too young to bet on. |
| OpenCut classic | The bridge in §6 lets the agent edit the same tab the human uses, through the same undo history. | **Chosen.** It's in your stack, it's MIT-licensed, and the editor is complete. The trade-offs: you own the code, and the effects library is thin. |

---

## Appendix A: references

- Fork: <https://github.com/mgamergo/splice>. Upstream rewrite: <https://github.com/OpenCut-app/OpenCut>.
  Classic: <https://github.com/opencut-app/opencut-classic>.
- MCP changelogs: [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog),
  [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
- Prior art for agent-controlled editors (reviewed for design, not code):
  [Opus Clip's overview of video MCP servers](https://www.opus.pro/blog/best-mcp-servers-for-video),
  [invideo MCP](https://invideo.io/mcp/) (agent edits a live browser timeline, the same model as
  "attached" mode), [mcp-video](https://pypi.org/project/mcp-video/) (an FFmpeg-only approach: no
  timeline, no undo, no live view, which is why it isn't the core here).

## Appendix B: key source locations (opencut-classic `apps/web/src`)

| Concern | Path |
|---|---|
| Editor root / managers | `core/index.ts`, `core/managers/*.ts` |
| Command base, batch, history | `commands/base-command.ts`, `commands/batch-command.ts`, `core/managers/commands.ts` |
| Timeline commands | `commands/timeline/{element,track,clipboard}/**` |
| Data model | `timeline/types.ts`, `project/types.ts`, `params/index.ts` |
| Placement / validation | `timeline/placement/*` |
| Time (ticks ↔ seconds) | `wasm/media-time.ts`, `rust/crates/time` |
| Render & export | `services/renderer/*`, `core/managers/renderer-manager.ts`, `export/index.ts` |
| Transcription / subtitles | `services/transcription/*`, `transcription/*`, `subtitles/*` |
| Storage | `services/storage/*` (IndexedDB + OPFS, migrations) |
| Keyboard actions (not for agents) | `actions/definitions.ts`, `actions/use-editor-actions.ts` |
