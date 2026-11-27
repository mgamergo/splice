# Splice scope

What Splice does today, what's next and in what order. Settled product decisions are in [docs/decisions.md](docs/decisions.md), terms in [GLOSSARY.md](GLOSSARY.md), checks that need the creator's laptop in [LAPTOP-CHECKS.md](LAPTOP-CHECKS.md). Last updated 2026-11-27.

## Built

Everything below is merged into `main` (PRs #1–#39).

- **Editor**: OpenCut classic, stripped and renamed to Premiere terms, fresh save format, Rust/WebGPU compositor in `packages/opencut-wasm`.
- **Agent layer**: editing API (`apply(ops)` as one undoable batch, revisions, sequence digest), the `splice` server, the tab bridge, `splice mcp`, footage referenced on disk.
- **Rough cut**: whisper.cpp transcription, take removal with removal markers (Restore and Swap), pauses, false starts, optional filler words, −14 LUFS loudness, optional noise reduction.
- **Horizontal workflow**: SRT captions with three correction scopes, MP4/SRT export pairs, approved checkpoints and the export gate, editable zooms, highlights and glass cards, music with ducking and a mastered mix, cut transcript panel.
- **Shorts**: Explainer and Raw styles, word-by-word burned-in captions, opening hook, caption placement.
- **Profile and housekeeping**: project brief, correction capture, profile agent and Profile panel, style defaults, Storage cleanup, recording verification on relink.
- **Performance**: range-limited decode, GPU encoder with fallback, export from 2D frame copies.

What the editor itself offers for finishing is still thin: one effect (Blur), no transitions (the tab says "coming soon"), no adjustment layers, plain text, static stickers (logos, flags, shapes), and Freesound search for sounds. Most of the plan below fixes that.

## TODO

- [x] **Filler words survive the rough cut.** "I say uh uh uh" kept every "uh". `findFillerWords` (`apps/server/src/pauses.ts`) only cut a filler that was a short sound with silence on both sides, and back-to-back fillers have no silence between them. A run of fillers with no other word between them is now aligned and cut as one, bounded by the silences around the whole run, and a real word heard in the same sound still keeps the run. Still to check on a real recording: whether Whisper `base.en` merges or drops repeated fillers.

## Plan

One PR per milestone, in this order. Each milestone is usable by the creator in the editor and by the agent through MCP: anything a panel can add, `sequence_apply` can add, and each library has a listing tool. Everything a milestone adds must look the same in preview and export, survive save and reload, and stay undoable.

### 1. Prepare button (the initiation sequence)

After importing recordings, one button in the Project items panel (and a matching `prepare` MCP tool) gets the project ready to edit:

1. Transcribe every recording with audio (whisper.cpp, cached).
2. Detect pauses and filler words on every recording.
3. Build the Raw sequence in recording order.
4. Build the Rough Cut: take removal, pauses, false starts, filler words (on by default here, with the toggle kept), loudness. Take ranking needs a model; use the configured profile-agent provider (OpenAI-compatible API or the opt-in CLI). With no provider, tighten only (pauses, fillers, loudness), skip take removal, and say so in the result.
5. Generate timed captions (SRT cues for Horizontal, burned-in word captions for Shorts) and the cut transcript, ready in their panels.

The button shows each step's progress, can be cancelled, and resumes from the last finished step after a reload, reusing cached analysis whose inputs still match. Reruns never overwrite a sequence the creator edited; they create a new Rough Cut. Implementation: a job on `splice` that chains the existing tools (`apps/server/src/transcription.ts`, `pauses.ts`, `rough-cut.ts`) plus the tab-side captions step, with status over the bridge.

Done when: importing a 30-minute recording and pressing Prepare ends with a Rough Cut, captions and transcript, without the agent.

### 2. Video effects and adjustment layers

Add effects to `apps/web/src/effects/definitions/` with their passes in the compositor (`packages/opencut-wasm/rust`, rebuilt with `build.sh`), all keyframable through the existing param channels:

- Blur family: Gaussian (exists), directional/motion, radial/zoom, tilt-shift, and region blur through masks (for hiding emails, keys and faces on screen).
- Color: brightness/contrast, exposure, saturation/vibrance, hue, temperature/tint, curves, LUT (`.cube`).
- Stylize: vignette, sharpen, film grain, glow/bloom, chromatic aberration, pixelate, glitch/RGB split, drop shadow, outline/stroke.
- Keying: chroma key with spill suppression.
- Frame: letterbox, rounded corners, picture-in-picture border.

Fill the **Adjustment** tab: an adjustment-layer clip that applies its effects to every track below it for its duration. Effect presets (a named stack of effects with parameters) can be saved and applied in one step.

### 3. Transitions

Fill the **Transitions** tab. A transition sits on the edit between two adjacent clips on a track and needs handles (unused source media) on both sides; when there isn't enough, it shortens or offers to use frozen frames.

- Built-in: cross dissolve, dip to black/white, wipe, slide, push, zoom in/out, whip pan with motion blur, blur dissolve, glitch.
- Luma-matte transitions: any grayscale matte video or image drives the reveal. Many free and paid transition packs ship this way, so it opens a large library.
- Overlay transitions: an alpha video (light leak, ink, shape wipe) placed over the cut.
- Default duration in settings; drag onto an edit or apply to all selected edits. Agent: a `transition` op in `sequence_apply`.

### 4. Text, emoji and caption styles

- Text presets: titles, lower thirds, callouts, labels, with in/out animations (fade, slide, pop, typewriter, word-by-word, letter stagger) built on keyframes.
- Emoji: **done for stickers**, as an **Emoji** tab in Stickers with Fluent Emoji Flat (MIT), browsable by category and searchable by name or character. Still to do: emoji inline in text, and animated emoji (check the license of any animated set before bundling it).
- Caption style presets for Shorts: karaoke highlight of the spoken word, word pop, box background, outline and shadow, emoji emphasis on keywords. Styles are saved with the project and in style defaults. Horizontal stays clean MP4 plus SRT.
- Import `.ass`/`.ssa` styles as caption presets.
- More fonts: Google Fonts exists; add user `.ttf`/`.otf` from the Library folder.

### 5. Sound effects

- A bundled starter SFX library (CC0: whoosh, swoosh, pop, click, ding, riser, impact, typing, notification) under `<SPLICE_ROOT>\Library\Sounds`, searchable alongside Freesound.
- Drag onto the timeline; volume and fades as for any audio clip; SFX duck with the rest of the final mix.
- Agent: `sounds_search` plus an op to place a sound at a sequence time, so the agent can add a whoosh on a zoom or transition.

### 6. GIPHY GIFs and stickers

Search GIPHY for GIFs, stickers (transparent) and memes from the **Stickers** tab:

- `splice` proxies GIPHY search with the key on the server (`SPLICE_GIPHY_API_KEY`), never in the tab. The panel shows "Powered by GIPHY" as GIPHY's terms require.
- Adding one downloads it to `<SPLICE_ROOT>\Library\Giphy\` and adds a project item referencing that file (ADR 0002), so the project doesn't depend on the network or on GIPHY keeping the file.
- GIFs come in as MP4 (smaller, decodes like video). Stickers need alpha, so they come in as animated WebP and play through `ImageDecoder`, which also gives animated GIF/WebP support to stickers the creator drops in.
- Agent: `giphy_search` returning IDs, titles and preview URLs, and an op to place a result at a time and position.

### 7. Premiere and After Effects asset packs

Most packs sold or shared for Premiere and After Effects are ordinary files underneath; the native project formats need Adobe's engines. Support what can render faithfully in the browser, and say clearly when a file can't be used:

| Format | Support |
|---|---|
| LUTs (`.cube`, `.3dl`) | Full, as the LUT effect |
| Lottie (`.json`, `.lottie`) exported from After Effects | Full: a Lottie clip rendered with a WebAssembly player (ThorVG or lottie-web) into the compositor, with editable text and colors where the file exposes them. This is the practical route for After Effects animations, and LottieFiles has a large free library. |
| Alpha video overlays (ProRes 4444 `.mov`, WebM VP9 alpha, PNG sequences) | Full. Chrome can't decode ProRes, so `splice` converts it on import with FFmpeg to VP9-alpha WebM, keeping the original |
| Luma-matte transitions | Full, through milestone 3 |
| Sound packs (WAV, MP3, AIFF) and fonts (`.ttf`, `.otf`) | Full |
| `.mogrt` | Partial, after a spike. It's a zip with `definition.json`, a thumbnail and the template. Templates authored in Premiere's Essential Graphics (text, shapes, images) map to Splice text and graphics with their editable fields. Templates authored in After Effects (`project.aegraphic`) need the After Effects render engine and can't be supported; Splice shows the thumbnail and suggests the Lottie export. |
| `.prfpset` (Premiere presets, XML) | Partial: effects with a Splice equivalent (Gaussian Blur, Lumetri basics, Transform, Cross Dissolve) map across; the rest are listed as not supported |
| `.ffx`, `.aep`, `.prproj`, third-party plugin effects | Not supported (binary or proprietary engines) |

Packs live under `<SPLICE_ROOT>\Library\` (a new folder next to `Footage` and `Exports`). Dropping a zip or folder onto the editor imports it: `splice` sorts the files by type, converts what needs converting, and the Library panel tabs list them with previews. `library_list` exposes them to the agent.

### 8. HyperFrames for the agent

Build [HyperFrames](https://github.com/heygen-com/hyperframes) (HTML, CSS and GSAP compositions rendered to video) into Splice so the agent can make richer graphics and place them itself:

- `splice` pins the HyperFrames CLI under `Tools` (Chrome and FFmpeg are already required) and installs its agent skills for the editing agent.
- MCP `graphic_render`: the agent passes a composition (HTML, duration, size, transparent or not), Splice lints and renders it to `Projects\<project>\Graphics\`, caches the render by content hash, and adds it as a project item that keeps the composition source.
- Placement: `at` a sequence time with a track and passage link puts the clip on the timeline as an undoable edit. Before the cut is finalized, or when the agent isn't confident of the spot, Splice renders it and adds a marker saying where it belongs, with an **Add here** action. This follows the existing rule that richer graphics come after the reviewed basic edit.
- Each graphic stays selectable: move, trim, hide, delete, or request a revision, which re-renders from its saved source in place. Approved checkpoints keep the exact render they used.
- Spike first: transparent output (WebM with alpha) and render time for a 10-second 1080p card on the laptop.

### 9. On-device vision

Let Splice look at the recording itself, so graphics and checks are grounded in what is on screen. Frames stay on the laptop.

1. **Evaluation (laptop).** A `bun run vision-eval` script: FFmpeg extracts frames just before and after each click in a set of real passages (a clearly labeled control, similar adjacent controls, a take that ends before the click; the Godot recording is a good first source). Each pair goes to Qwen2.5-VL 3B (3.2 GB) and Moondream (1.7 GB) through Ollama's local API, one model loaded at a time on the RTX 5050's 8 GB. Score: reads the control label, locates it, describes what changed, admits insufficient evidence. Measure response time and editor playback smoothness with Chrome open. Pick the model from the results.
2. **Integration.** A vision provider in `splice` (Ollama URL and model in settings) and an MCP `frame_observe` tool: timestamps, an optional region and a question in; visible text, target rectangles, a short observation and a confidence out. The agent gets observations, never pixels.
3. **Screenshot access.** Off by default, enabled per project. `frame_screenshot` returns a frame or crop to the agent, and the creator can see which frames were shared and turn it off.
4. **Use.** The graphics pass uses observations for zoom targets and highlights, placed with the existing graphics tools; take review flags an action missing from the kept take; later, a highlight follows a moving control.

### Gaps against premium editors

Milestones 10–24 come from comparing Splice with Premiere, Resolve, Final Cut, Descript, Screen Studio, Camtasia, CapCut, Gling, Auphonic and Frame.io (2026-11-27). They follow milestone 9 in this order, but 10–12 make the existing rough cut feel finished and can move ahead of milestones 2–9 if the creator chooses.

### 10. Word timing and transcription accuracy

Whisper's word times drift by up to half a second, which limits every cut, filler and caption that depends on them.

- Forced alignment after transcription (a wav2vec2 CTC aligner, as WhisperX does) moves each word to its sound, cached next to the transcript and keyed by the same fingerprint. Pause detection, filler alignment, karaoke captions and false-start edges use the aligned times.
- Offer `large-v3-turbo` on CUDA as a model choice beside `base.en`.
- Feed the creator's reusable caption spellings into Whisper's prompt as vocabulary, so product names come out right the first time.

Done when: on a generated fixture with known word times, aligned words land within one frame, and a filler cut leaves no audible fragment.

### 11. Clean audio at every cut

- A short fade (5–10 ms, set in settings) on both sides of every speech cut, in preview and export, so ripple-deleted pauses, false starts and fillers never click.
- Room tone: capture a stretch of the recording's quietest audio and optionally fill cut pauses with it instead of digital silence.
- Turn down breaths and mouth clicks without cutting them, using the clicks `detect_pauses` already finds between silences. Off by default; a toggle in the rough cut and Prepare.

### 12. Trimming

- Trim tools beside Razor: ripple, roll, slip and slide, each with a keyboard nudge by frame.
- Trim mode: a two-up preview of the outgoing and incoming frames while trimming an edit.
- J-K-L shuttle with rising speeds, in and out marks on the sequence, and insert, overwrite, lift and extract.
- Split edits (J-cuts and L-cuts): trim a clip's audio apart from its picture while they stay linked.
- Snap to transcript word boundaries while trimming.

### 13. Source editing and timeline structure

- A source monitor: open a project item, mark a range, then insert or overwrite it into the sequence at the playhead.
- Track targeting and source patching, sync lock and track lock.
- Nested sequences: a sequence used as a clip in another, edited in place.
- Close all gaps, select forward from the playhead, match frame and replace edit.
- Keyboard shortcut presets that match Premiere and Resolve, on top of the existing keybindings.
- Agent: the same edits as `sequence_apply` ops.

### 14. Cursor and input data

What makes Screen Studio recordings look finished comes from knowing where the cursor was and when it clicked.

- A small companion recorder (or an OBS script) logs cursor position, clicks and keystrokes with timestamps beside each recording in `Footage`. Splice links the log to the project item and keeps it through relinks.
- From the log: cursor smoothing, a larger or replaced vector cursor, a ripple on each click, hiding the cursor when idle, and shortcut pills ("Ctrl+K") over the frame.
- Zooms that follow the cursor with spring easing and motion blur, with the cursor held steady inside the zoom so small movements don't shake the framing. Agent zooms keep their placement rules; following is a per-zoom option.
- Without a log, the cursor and clicks come from frames once milestone 9 can find them.

### 15. Activity-aware tightening

Silence on a screen recording often means something is happening on screen, such as an install or a build.

- Measure how much the picture changes in each pause. Pause removal speeds up a busy pause (with an optional "4×" badge) instead of cutting it, and `rough_cut` reports the time each choice saved.
- Speed ramps with presets, reverse, and freeze or hold frame to cover narration over a still screen, in the Speed tab and as ops.
- Typing and scroll speed-up presets, using the input log from milestone 14 when there is one.

### 16. Automatic redaction

- Read on-screen text locally (OCR) and find emails, API keys, tokens, `.env` values and other secrets.
- Add a region blur (milestone 2) that follows each match while it is visible, and list every match in the export review so the creator keeps or removes it.
- A redaction check runs before every export even when the creator added no blurs.

### 17. Voice enhancement and audio effects

- A one-step voice cleanup preset (like Studio Sound): de-reverb, EQ, compression and de-essing, run locally (DeepFilterNet or Resemble Enhance), measured before loudness.
- Audio effects per clip and per track: parametric EQ, compressor, gate, limiter, high-pass and de-esser, keyframable like video effects.
- Volume drawn on the clip over the existing volume keyframes; per-track meters, solo, mute and pan.
- Loudness presets per platform (YouTube −14, podcast −16, broadcast −23 LUFS).
- Record a voiceover pickup inside Splice from the microphone, placed at the playhead on a new track, to replace a fluffed sentence.

### 18. Music tools

- Beat detection on a music track, with beats as snap points and a cut-to-beat option.
- Remix a track to the sequence's length by looping and cutting at beats, instead of only fading the end.
- Stem separation, so the music's vocals duck harder than its instruments under speech.

### 19. Markers, chapters and YouTube metadata

- Colored markers with durations and a marker list panel.
- Chapters generated from the cut transcript, editable as chapter markers, exported with the MP4/SRT pair as YouTube timestamps.
- A suggested title, description and tags from the transcript and brief, saved beside the export. Upload stays with the creator.

### 20. Notes for the agent

- Timeline notes with a time or range ("tighten this", "zoom on Save") that the agent reads over MCP (`notes_list`, `note_resolve`) and resolves as undoable edits.
- A visual diff between two revisions on the timeline, built on `checkpoint_compare`.
- A command bar in the editor that sends an instruction with the selected range to the agent, without switching to T3 Code.

### 21. Preview and timeline polish

- Preview resolution (full, ½, ¼), a dropped-frame indicator, and full-screen preview on a second monitor.
- Filmstrip thumbnails from across each clip instead of one repeated thumbnail, and waveforms that keep their detail when zoomed in.
- A timeline minimap, an undo history panel with named steps, a command palette and right-click menus throughout.

### 22. Caption languages and checks

- Translate captions with the configured provider and export one SRT per language beside the MP4.
- Caption checks in the export review: characters per second, line length, minimum duration and overlaps.
- Optionally embed captions in the MP4 as a subtitle track.

### 23. Export options

- Export the in-out range, a still frame, a GIF or audio only.
- 1440p and 4K export from 1080p recordings with text-aware sharpening, so YouTube serves the video at its higher bitrate.
- A render queue that renders in the background while editing continues.
- Archive masters in ProRes or DNxHR through FFmpeg on `splice`.
- An OpenTimelineIO export of the sequence as a backup, not a Premiere handoff.
- Collect project: bundle a project with the media it uses for backup or a move to another machine.

### 24. Picture, screen look and pacing review

- Scopes (waveform, vectorscope, histogram) and automatic white balance and exposure.
- A framed look for screen recordings: the recording inset over a wallpaper or gradient with padding, rounded corners and a shadow; browser and phone frames for Shorts; a spotlight that dims everything except the active window or region.
- Pacing review in the export review: long stretches with no visual change, drops in speaking rate, a point repeated across sections, and a slow opening.
- Flag jargon and likely mispronunciations as candidates for a voiceover pickup.
- A thumbnail helper that suggests frames and overlays text, independent of video delivery.

### Later

- Gaze-continuity checks after a take swap, and moving-target tracking (needs milestone 9).
- Editing by deleting transcript text.
- Proxies, only if laptop playback stutters.
- Smart rendering: copy unchanged stretches into the export without re-encoding. Spike first; it is hard with WebCodecs.
- Regenerating one fluffed word with a voice clone, opt-in and with the creator's consent.
- Need a change to the decisions first: cutting Shorts from a horizontal video, uploading to YouTube, and a Premiere handoff.

## Known limitations

- Windows reserved names like `CON.demo` in export stems.
- After a razor split, a cue edit falls back to the transcript words if the same words are heard more than once.
- Exports made before #21 stay as loose files in `Exports/`; legacy checkpoints use path, size and modification time until reapproved.
- Graphics: highlights sample the picture transform at their midpoint.
- Final mix: older mixes keep baked-in ducking until refit; music stays ducked over untranscribed recordings.
- Shorts: automatic caption placement uses graphics targets and presets, so crowded frames can need manual placement; legacy Raw hooks keep their timing until set again.
- Profile: only one `splice` server per profile root; free-form MCP and legacy `profile.md` text revert as one field; CLI provider terms need the creator's confirmation; live provider sign-in unverified.
- Cleanup: on POSIX a same-name replacement inside `Cache` can race the final check; Windows and macOS unverified.
- Relink: approvals and transcripts keyed only by the older sampled fingerprint may need reapproval or retranscription; accepting a replacement resets undo.
- Brief: one-take sections from older cuts must be declared again to be protected.
- Headless Chromium renders black frames with `--disable-vulkan-surface`; that is the environment, not Splice.

## How the work runs

- One PR per milestone, stacked when it depends on the one before. Never push to `main`; merge through PRs.
- One review round per PR; fix the P1 and P2 findings, record P3s as known limitations in the PR.
- Gate before merging: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build:web`.
- Laptop-only checks go in `LAPTOP-CHECKS.md`.
- No co-author trailers. Never commit `AGENTS.md` or `CLAUDE.md`.
