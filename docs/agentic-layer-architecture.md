# Splice architecture

**Status:** accepted · **Updated:** 2026-11-22

This document describes how Splice is built. The decisions behind it are in [decisions.md](decisions.md), and the vocabulary is in [GLOSSARY.md](../GLOSSARY.md). Where this document and `decisions.md` disagree, `decisions.md` wins.

## 1. Goal

Splice is a browser video editor in which an agent makes the **rough cut** from a creator's raw voiceover recordings. The creator then does the **finishing pass** by hand. The agent works live on the same **timeline panel** the creator is looking at.

What the agent does in a rough cut:

1. Finds the **sections** in the recordings and the **takes** of each one.
2. Keeps each section's **best take**.
3. Removes the **bad takes**, **false starts** and **pauses**, and **filler words** when that option is on.
4. Leaves **removal markers**, so any cut can be restored or swapped at any time.
5. Normalizes loudness to −14 LUFS.
6. For a **Short**, adds burned-in captions.

The agent learns the creator's taste from **corrections**. Those corrections become an **editing profile** that a small **profile agent** keeps up to date.

## 2. The editor engine

Splice is OpenCut's classic editor (`opencut-classic@cf5e79e`), stripped down to the editor and renamed to Premiere terms ([ADR 0001](adr/0001-fork-opencut-classic-and-diverge.md)). Everything below lives in `apps/web/src`.

- **`EditorCore`** (`core/index.ts`) is a singleton that owns the managers:
  - `timeline`, `command`, `playback`, `sequences`, `project`, `media`, `renderer`, `save`, `audio`, `selection`, `clipboard` and `diagnostics`.
  - Each manager has plain methods plus `subscribe()`, and none of them depends on React. That is what makes an agent layer possible.
- **Commands** (`commands/`, `core/managers/commands.ts`) are the editing primitives:
  - Each one has `execute`, `undo` and `redo`.
  - `BatchCommand` groups several commands into one undo step.
  - `CommandManager` handles history, ripple adjustments, selection and reactors.
  - The editor has about 40 commands, covering clips (insert, move, razor, delete, duplicate, update), tracks, effects, keyframes, masks, sequences, markers, project items and project settings.
- **Data model** (`timeline/types.ts`):
  - A `TProject` holds `TSequence[]`, and each sequence holds `SequenceTracks { main, overlay[], audio[] }`.
  - A clip has `startTime`, `duration`, `trimStart`/`trimEnd`, flat `params`, keyframe `animations`, `effects`, `masks` and `retime`.
- **Time** is `MediaTime`: a branded integer tick count from the `opencut-wasm` npm package.
- **Media** is decoded and encoded through mediabunny (WebCodecs).
- **Preview** is drawn by a WebGPU compositor written in WASM, with a Canvas fallback.
- **Export** of the sequence goes through `SequenceExporter` (MP4/WebM).
- **Captions**:
  - The browser Whisper worker generates captions.
  - `subtitles/` parses SRT/ASS.
- **Persistence**: projects are saved at format v1 in `splice-*` IndexedDB databases (`services/storage/format.ts`).

The engine depends on browser APIs: WebCodecs, WebGPU/Canvas, AudioContext, Workers and IndexedDB. A server process can't import it. The agent therefore drives a **live editor tab**.

## 3. Runtime

```text
 T3 Code agent ──MCP stdio──► splice mcp ──local RPC──► splice (local server) ◄──WebSocket── editor tab (Chrome)
                                                         │  hosts the editor UI                │
                                                         │  streams media from D:\Splice      ├─► EditorCore
                                                         │  bridge to the tab                 │   (commands, renderer,
                                                         │  whisper.cpp, FFmpeg analysis      │    export)
                                                         │  profile agent                     │
                                                         └──────────────────────────────────────┘
```

| Process | Started by | Role |
| --- | --- | --- |
| `splice` | The creator, by hand | A long-running local server. It hosts the editor and streams project items from disk ([ADR 0002](adr/0002-project-items-reference-files-on-disk.md)). It also runs the WebSocket bridge to the tab, transcription (whisper.cpp), FFmpeg analysis and the profile agent. |
| `splice mcp` | T3 Code, as a stdio MCP server | A thin adapter. It connects to `splice` and starts it if it isn't running. It holds no state, so T3 Code can restart it at any time. |
| Editor tab | The creator, in Chrome | Executes every edit through `EditorCore`. It reconnects to `splice` on its own. |

Everything runs on the creator's Windows laptop. Data lives under `D:\Splice\`, in `Footage`, `Projects`, `Cache`, `Profile`, `Exports` and `Tools`.

A headless Chromium launched by Playwright runs the same tab code on a devbox. That's for tests and evaluations only.

## 4. The editing API (in the tab)

The MCP tools are thin wrappers. The real work lives in `apps/web/src/agent/editor-api.ts`.

```ts
interface EditorApi {
  getState(opts?: { detail: "digest" | "full" }): SequenceSnapshot; // includes `revision`
  listProjectItems(): ProjectItemInfo[];
  apply(req: { ops: EditOp[]; expectedRevision: number; label: string }): ApplyResult;
  renderFrame(at: TimeSpec, opts?: { width?: number }): Png;
  export(opts: ExportOptions): ExportHandle; // long-running, with progress
}

type EditOp =
  | { op: "insert_clip"; projectItemId: string; at: TimeSpec; track?: TrackRef; source?: Range }
  | { op: "move"; targets: ClipRef[]; to: TimeSpec; track?: TrackRef }
  | { op: "trim"; target: ClipRef; inPoint?: TimeSpec; outPoint?: TimeSpec }
  | { op: "razor"; targets: ClipRef[]; at: TimeSpec }
  | { op: "ripple_delete"; ranges: Range[]; tracks?: TrackRef[] }
  | { op: "set_params"; target: ClipRef; params: Record<string, ParamValue> }
  | { op: "add_marker"; at: TimeSpec; name: string; data?: RemovalMarkerData }
  | { op: "restore_takes"; markerId: string; takeIndex?: number }
  | { op: "swap_take"; markerId: string; takeIndex: number }
  | { op: "add_text"; text: string; at: TimeSpec; duration: TimeSpec; style?: TextStyle }
  | { op: "add_effect"; target: ClipRef; effect: string; params?: Record<string, ParamValue> };
// …one variant per command the agent needs; more are added as features need them.

type TimeSpec = { seconds: number } | { frame: number } | { timecode: string };
```

Rules:

- **Explicit targets.** Every op names its clip, track and time. Nothing reads the selection or the playhead, so the action system (`invokeAction`) is not used. Commands receive the editor instance instead of calling `EditorCore.getInstance()`.
- **One call is one undo step.** Each `apply()` becomes one `BatchCommand`, labeled for example "Agent: rough cut".
- **The creator wins.** A monotonic `revision` increments on every command. `apply()` requires `expectedRevision`. If the creator has edited in the meantime, the call fails with `REVISION_CONFLICT` and the fresh digest, and the agent re-reads and plans a corrective edit. The agent never undoes past the creator's edits.
- **Validate, then mutate.** Ops are checked with zod at the boundary. Semantic checks follow: the clip exists, the track accepts it, and the time falls inside the source. If any op fails, nothing is applied.
- **Seconds in, seconds out.** Times are converted to ticks with the WASM helpers, and results are rounded to frames.
- **Useful results.** Each write returns the new clip IDs, the new revision and a one-line diff.

### 4.1 The sequence digest

The agent reads a compact text view of the sequence by default:

```text
project "Episode 12" horizontal 1920x1080 @30fps, revision 41
sequence "Rough Cut" 00:08:12.10
V1: [c1 rec-01.mkv 0.00–18.20 (src 4.00–22.20)] [c2 rec-01.mkv 18.20–41.00 (src 63.10–85.90)] …
A1: (linked audio)
markers: 18.20 removal "Intro" (3 takes stored) [m1]
project items: rec-01.mkv (42:10, 1080p, audio), rec-02.mkv (06:30)
```

`getState({ detail: "full" })` returns the full JSON when the agent needs precision.

## 5. Rough-cut pipeline

| Step | Where it runs | How |
| --- | --- | --- |
| Order the recordings | `splice` | Probe the files and sort them by recording time into one continuous **raw sequence**. |
| Transcribe | `splice` | whisper.cpp with word timestamps, cached in `Cache\`. CUDA on the laptop, CPU elsewhere. |
| Find pauses | `splice` | FFmpeg `silencedetect`, cached in `Cache\`. The transcript only joins silences around a click: Whisper's word times drift, so pause edges always come from the audio. |
| Find sections and takes | agent | From the transcript: restarts of the same passage are takes of one section. |
| Rank takes | agent | Completeness, then fluency, then pacing, guided by `profile.md`. |
| Find false starts and filler words | agent and `splice` | The agent finds false starts in the transcript. `splice` finds English filler words and moves them to their sound between two silences, leaving any filler whose sound could be a real word. |
| Build the cut | tab | Create the **Rough Cut** sequence from the raw sequence in one undo step: ripple deletes plus removal markers for bad takes; pauses (keeping 0.2 s of breath per side), false starts and filler words are ripple deleted without markers. |
| Loudness | `splice` and tab | FFmpeg `ebur128` measures; a gain param applies the correction. |
| Captions (Shorts) | tab | Word-by-word captions from the same transcript. |

A **removal marker** stores the bad takes it replaced, as source ranges. **Restore** and **Swap** apply ordinary undoable edits built from that data, so they keep working after any amount of later editing.

Source ranges use `projectItemId`, `sourceIn`, and `sourceOut`, with in and out measured in source seconds. `restore_takes` restores all stored takes in order when `takeIndex` is omitted. Both ops use zero-based indices.

Swap replaces the nearest contiguous run of tracked clips that still show the best take's source range. When you add a removal marker within one frame of the best take, the marker tracks the original clips across splits and moves. A marker placed farther away supports Restore. It replaces only the surviving portion of a trimmed best take with the entire chosen take. The original best take’s full source range goes back into the marker. Swap leaves the sequence intact if it cannot identify the best take or its paired extracted audio, or if rippling would overlap clips on another track.

## 6. The bridge (`splice` ↔ tab)

- **Transport:** a WebSocket on `127.0.0.1` at `/splice/tab`. The tab connects out to `splice`. `splice` also proxies the editor's own Next.js server, so the editor, the bridge and project media share one origin.
- **Auth:** `splice` mints a token and keeps it in `Cache/session.json`, so it survives restarts. The tab receives it in the URL fragment, which never reaches server logs, and sends it in its first message. Connections from any other `Origin`, and requests with a `Host` other than `127.0.0.1` or `localhost` on its port, are rejected. One tab holds the connection at a time; a newer tab takes over.
- **`splice mcp` → `splice`:** JSON-RPC over HTTP POST at `/splice/rpc`, with the token as a bearer token read from `Cache/session.json`. Requests that carry an `Origin` header (that is, from a browser) are refused.
- **Protocol:** JSON-RPC 2.0, mirroring `EditorApi` (`editor.apply`, `editor.getState`, …). Notifications cover `state.changed {revision}`, `export.progress` and `correction.recorded`.
- **Media:** the tab plays project items under `Footage` from `/splice/media/<path>` with range requests, and never copies them. Media requests are authorized by an HttpOnly `SameSite=Strict` cookie that the tab gets by posting its token to `/splice/session`. Paths are plain relative paths: no empty, `.` or `..` segments, and symlinks must resolve inside `Footage`.
- **In the editor:**
  - an "Agent connected / editing…" indicator,
  - a Stop button that blocks agent writes,
  - profile question cards,
  - the Profile panel.

## 7. MCP surface (`splice mcp`)

Built on the official MCP TypeScript SDK, over stdio. The tools:

| Group | Tools |
| --- | --- |
| Project | `project_create` (format: horizontal or Short), `project_open`, `project_list` |
| Project items | `items_import` (paths under `D:\Splice\Footage`), `items_list`, `items_probe` |
| Read | `sequence_get` (digest or full), `frame_render` |
| Edit | `sequence_apply` (a batch of `EditOp`s) |
| Analysis | `transcribe`, `detect_pauses`, `measure_loudness` |
| Rough cut | `rough_cut` (the whole pipeline in §5, as one undo step), `takes_list` |
| Profile | `profile_get`, `profile_pending`, `profile_apply` |
| Output | `export` (long-running, with progress) |

Long jobs (transcription, rough cut, export) report progress and can be polled. Tools take handles as arguments rather than relying on protocol sessions, which matches the MCP 2026-07-28 direction.

## 8. Editing profile and profile agent

- The editor records every **correction**, with the agent's choice and the creator's, in `D:\Splice\Profile\corrections.jsonl`.
- The **profile agent** runs inside `splice`. It uses an OpenAI-compatible API (OpenRouter or a local model) or a CLI the creator is signed in to (`codex exec` / `claude -p`).
  - About 30 seconds after the creator stops editing, it reads the new corrections.
  - It updates `profile.md` and asks at most one **profile question**.
  - It never edits the sequence.
- With no provider set up, corrections queue in `pending.jsonl`. The MCP tools `profile_pending` and `profile_apply` let the T3 Code agent process them.
- The agent reads `profile.md` before every rough cut.

## 9. Security

- Everything binds to loopback, with a token and an `Origin` check.
- Imports and exports accept only paths under `D:\Splice\`. Symlinks are resolved and `..` is rejected.
- Provider keys stay in `splice` and never reach page code.
- Transcript text and file names are data. They are never treated as instructions.

## 10. Work plan

| Phase | Scope | Verified on |
| --- | --- | --- |
| 0 | Restore classic, strip it, apply the Premiere rename, start the fresh v1 format, get checks green, add `LAPTOP-CHECKS.md`, rewrite this document | devbox |
| 1 | `EditorApi` in the tab: `apply`, revisions, digest, validation; a pure test harness for ops | devbox |
| 2 | `splice` server, bridge, `splice mcp`; serving project items from disk | devbox, then laptop (Windows paths) |
| 3a | Transcription, take removal, removal markers (Restore and Swap) | devbox (synthetic recordings), then laptop (CUDA) |
| 3b | Pauses, false starts, filler words, loudness, the Short format with captions | devbox |
| Later | Profile agent and Profile panel, transitions and effects, GIF/WebP stickers, ducking, evaluations | — |

Test recordings for the devbox are generated by script (text-to-speech plus FFmpeg, with planted retakes, pauses and filler words). They are never committed. PRs describe what was observed.

## 11. Risks

- **Browser memory with 60-minute 1080p sources.** Playback streams from disk, and proxies are added only if the laptop check shows stutter.
- **Take detection quality.** It depends on transcript accuracy and the agent's judgment. Corrections and the editing profile are the feedback loop, and evaluations track whether choices improve.
- **WebGPU on hybrid-GPU laptops.** Testing starts on the Radeon 860M. Forcing the RTX 5050 comes later.
- **Concurrent edits.** Revisions plus `REVISION_CONFLICT` keep the creator authoritative. Expect the agent to re-plan often while the creator is active.
