# Splice decisions

The settled outcome of the design grilling that ended on 2026-11-22. Terms follow [GLOSSARY.md](../GLOSSARY.md). Where this file and [agentic-layer-architecture.md](agentic-layer-architecture.md) disagree, this file wins until the report is rewritten.

## Baseline and repo

- Build on OpenCut classic `cf5e79e`, reset `main` to it and never track upstream ([ADR 0001](adr/0001-fork-opencut-classic-and-diverge.md)).
- Strip everything that isn't the editor.
- Rename the code to Premiere vocabulary (Sequence, Clip, Project item, Track, Razor…).
- Start a fresh save format at v1 and drop classic's migrations.
- Keep the `opencut-wasm` npm package until a feature needs Rust changes.

## Runtime on the laptop

- The laptop runs Windows on a Ryzen AI 7 350, with a Radeon 860M integrated GPU, an RTX 5050 laptop GPU and 24 GB of RAM.
- Splice runs as two services, both started by hand (no autostart):
  - `splice` is a long-running local server. It hosts the editor, streams media from D:, runs the WebSocket bridge to the tab and runs the profile agent.
  - `splice mcp` is a stdio MCP server launched by T3 Code. It connects to `splice` and starts it if it isn't running. The editor tab reconnects on its own.
- The agent (T3 Code) runs locally on the laptop, not on remote machines.
- Project items reference files on disk; nothing is copied into browser storage ([ADR 0002](adr/0002-project-items-reference-files-on-disk.md)). The editor offers to relink missing files.
- All data lives under `D:\Splice\`, in these folders: `Footage\`, `Projects\`, `Cache\` (safe to delete), `Profile\`, `Exports\`, `Tools\`.
- Transcription for the agent uses whisper.cpp. `splice` downloads a pinned, prebuilt Windows CUDA build (the RTX 5050 needs CUDA 12.8+) and falls back to the CPU. The browser's Whisper stays for captions.
- All laptop testing is done on the Radeon 860M first. Forcing the RTX 5050 comes later.

## Recordings and output

- Recordings are voiceover with screen video, 1080p, typically 30–45 minutes and up to 60 including bad takes. The creator is never on camera, so there is no visual take judgment.
- A video's recordings can be several files. They are treated as one continuous session in recording order, and a section's takes can span files.
- Each project has one **format**, chosen when it's created:
  - **Horizontal**: 16:9, 1080p30, MP4 (H.264 + AAC).
  - **Short**: 9:16, 1080×1920, made from separate vertical recordings and never cut from a horizontal video. Its rough cut always gets burned-in word-by-word captions in one default style that can be restyled.
- There are no proxies at first. They get added only if playback stutters on the laptop.

## Rough cut

- The agent builds a new **Rough Cut** sequence and leaves the **raw sequence** untouched. Cutting the raw sequence directly may come later, once the profile and pipeline are reliable.
- **Take removal** keeps each section's **best take**. Ranking order: completeness, then fluency (fewest false starts and filler words), then pacing. Judgment comes from the transcript and audio only.
- Bad takes are ripple deleted. A **removal marker** stores them and offers **Restore** and **Swap** at any time, as new undoable edits that don't depend on undo history.
- Pauses and false starts are removed. Filler-word removal is a toggle.
- Cuts follow the audio, and jump cuts in the picture are accepted.
- Audio is normalized to −14 LUFS. Noise reduction is available but off by default.
- Recording is unscripted by default. Support for a script is added only if unscripted doesn't work.

## Live editing

- The agent's edits show live on the timeline.
- The creator's edits always win: the agent's pending batch is discarded, and the agent re-reads the sequence and makes a corrective edit. It never uses undo across the creator's edits.

## Editing profile

- **Corrections** are creator edits that change the agent's cuts (a swap, a restore, re-trimming a pause). They are logged to `D:\Splice\Profile\` as raw data, and `profile.md` is the short summary the agent reads before every rough cut.
- The first take rankings are done inside Splice, by swapping and restoring takes on agent rough cuts of test videos.
- The **profile agent** runs inside `splice`. It is lightweight and never edits video. Once the creator has been idle for about 30 seconds, it analyzes the corrections, updates the profile and asks at most one **profile question** per batch, as a card in the editor that can be dismissed.
- Profile updates apply silently. They are listed in a Profile panel, where each one can be reverted.
- Providers:
  - an OpenAI-compatible API (OpenRouter, or a local model), or
  - a CLI the creator is signed in to (`codex exec` / `claude -p`); check each CLI's terms on non-interactive use before building this.

  There is no direct Claude API provider, and no grabbing of subscription tokens. The model is chosen later.
- Keys stay in the server, never in page code. With no provider set up, corrections queue in `pending.jsonl`. The MCP tools `profile_pending` and `profile_apply` let the T3 Code agent process them, and any other agent can work from the file.

## Development process

- Develop and verify on boxes.dev devboxes, overnight and without the laptop.
- No media goes into git. Test recordings are generated by script on the devbox, and the PR describes what was observed.
- Profile-agent tests use a real provider when a key is available in Infisical, and mocked responses otherwise.
- Laptop-only checks go in `LAPTOP-CHECKS.md` at the repo root, under Pending and Verified (with date and commit SHA).
- A PR that adds Pending entries is labeled `needs-laptop` and waits for the creator to verify and merge. Every other PR auto-merges once devbox verification and GitHub Actions (lint, types, unit tests) pass.
- Commits carry no co-author trailer.

## Build order

1. **Phase 0**: rewrite the architecture report to match this file. Restore classic, strip it, rename to Premiere terms, start the fresh save format, and get tests and type checks green. Create `LAPTOP-CHECKS.md`.
2. **Phase 1**: the editing API (atomic `apply(ops)` as one undoable batch, revision checks, sequence digest).
3. **Phase 2**: the `splice` server, the bridge, and `splice mcp`.
4. **Phase 3a**: transcription (whisper.cpp), take removal and removal markers.
5. **Phase 3b**: pauses, false starts, filler words, loudness, and the Short format with captions.
6. **Later**: the profile agent and the Profile panel, transitions and effects, GIF/WebP stickers, ducking, evaluations.

## End-to-end editing workflow

The first complete workflow targets a Horizontal YouTube video built from screen recordings with voiceover. Keep important on-screen actions visible when placing graphics and captions. Each project keeps its original format and references its recordings on disk. The video style is chosen within that format.

Preview, later edits and export use the editable sequence (ADR 0003). Keep whisper.cpp for now and assess graphics tools such as HyperFrames against the finished workflow. Revisit tool choices after testing with actual recordings.

### Horizontal graphics and delivery

Inspect recorded frames before placing graphics. For a UI demonstration, zoom to make the relevant control and its resulting state legible. Frame the new detail near the previous shot's point of attention. Leave the shot wide when the target is uncertain. Use glass cards for explanations the recording cannot show.

The agent applies its first graphics pass as undoable sequence edits. Creator-adjusted graphics follow their referenced action through cuts and retain their timing offset. Flag a graphic for review if a take swap removes its action. Preserve explicit deletions across reruns.

The creator finishes the edit in Splice. The workflow has no Premiere handoff. Horizontal delivery includes the reviewed 1080p30 MP4 and corrected SRT captions for YouTube. Thumbnails are independent of video delivery. Music is optional.

### Framing, corrections and final review

Infer the viewer's point of attention from the last meaningful action, narration and preceding crop. An idle cursor does not redirect attention. Cut directly to a known target when the destination matters. Preserve navigation when the viewer needs to reproduce the route. Keep a search field and its results in a stable frame while the creator types. Keep labels and the resulting UI state readable even when this requires a small shift in attention.

The creator can reposition and magnify a generated zoom in the preview and trim its duration on the timeline. Preserve those adjustments on later graphics passes. During screen analysis, flag any action missing from the selected take, even if its spoken delivery is strong. The creator decides whether to substitute picture from another take.

Caption corrections can apply to one cue, across the project, or to a reusable spelling chosen by the creator for future projects. Time the corrected SRT against the final reviewed sequence.

Export is the creator's explicit final approval. Show unresolved issues and let the creator fix or dismiss each one. Produce the MP4 and SRT from the same approved sequence revision.

### Recuts, recovery, music and export retries

After a take changes, check both adjacent transitions for gaze continuity. Adjust agent-generated framing where needed. Preserve manual framing and flag it for review if the transition no longer works. Track creator adjustments per property. A rewritten card title stays intact as its cue moves. Flag a possible mismatch if the narration changes its meaning.

On reopen, retain completed edits and offer Resume for an interrupted pass. Resume from the current sequence, reuse completed analysis whose inputs still match, and avoid duplicating graphics. Selecting a review issue plays the surrounding edit. Keep a dismissal until the evidence behind that issue changes.

Music is opt-in for the first horizontal workflow. The creator selects a track. The agent fits it to the sequence, fades its ends and ducks it under speech. The creator can audition and adjust the mix.

Publish the MP4 and SRT together only after both succeed. Preserve the previous complete pair on failure, identify the failed step and offer a retry. Edits during rendering create a newer revision. Finish rendering the approved revision and tell the creator when a newer edit is available.

### Graphics milestones and evaluation

For each video, cut the footage first, then add editable zooms, highlights around important screen details, and basic cards. The creator watches this edit in Splice, makes or requests changes, and finalizes it. Only then can a HyperFrames pass add richer graphics to the reviewed video. Keep each planned graphic linked to its spoken passage, source frames and intended target so the creator can inspect the evidence.

Keep the chosen style with the project. Offer a preview before applying updated style defaults and preserve properties the creator adjusted. Repeated visual corrections can inform reversible framing preferences separately from take-selection preferences. Keep one-off corrections local to the project.

First review an exported passage with a search, a menu transition and a visible state change at normal speed. Check that the viewer can follow the action, read the control and see the result. Keep failed passages as regression examples. Then test responsiveness, recovery and MP4/SRT sync on a real 30–45 minute laptop project.

### Screenshot access for editing agents

By default, Splice inspects recording frames locally. The editing agent can receive timestamps, target rectangles and short observations, including relevant visible UI text. A hosted model can therefore receive these observations even when screenshots stay on the laptop.

The creator can enable access to selected frames for an individual project. With this enabled, the editing agent can request a screenshot to resolve an uncertain observation. Choose the local vision model after comparing candidates on real laptop footage.

### Local vision evaluation and creator review

Compare Qwen and Moondream on the same recorded passages. Include a clearly labeled control, adjacent similar controls, and a take that ends before the click. Evaluate correct target selection, recognition of the resulting state, and whether the model recognizes insufficient evidence. Measure response time and playback smoothness on the laptop.

Enabling screenshot access for a project covers individual frame and crop requests during the editing session. Let the creator inspect which frames were shared and disable future requests.

Ground explanatory cards in the recording or creator-supplied notes. When evidence supports only a label, use the label or let the demonstration play.

Support manual picture-only repair during the first horizontal milestone. The creator can keep narration from one take, overlay screen footage from another, and preview their timing together. The agent may flag the missing action and suggest a replacement take. The creator decides whether to use it.

### Directing an edit

The recordings alone are enough to start. An optional project brief guides this edit without changing future project defaults. Preserve the teaching order through take selection and tightening. Moving the payoff or removing an entire section to meet a duration requires an explicit instruction to restructure.

The creator can select a passage in Splice and direct the editing agent in T3 Code. MCP supplies the selected sequence and range. Show the consequences for adjacent transitions and preserve unrelated edits.

### Finalizing the cut and adding richer graphics

Finalizing the cut from T3 Code or Splice saves the exact version the creator reviewed. The creator can return to it, compare a passage with embellishments off, or export the approved basic edit.

HyperFrames may choose passages to embellish within the approved timing. Ask the creator before extending a shot or moving narration. Each graphic is individually selectable in Splice. Support moving, trimming, hiding, deleting and requesting a revision to one graphic in place. Manual editing of its internal shapes and keyframes can wait.

The basic graphics pass can track a visibly identifiable UI control through movement. A highlight follows its target and disappears when the target leaves view.
