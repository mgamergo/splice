# Continue here

Where the Splice build stands, and what to do next. Last updated 2026-11-24.

## Progress

```
Core editor and agent pipeline  [####################] 100%  Phases 0–3b, range export
Horizontal workflow (H1–H6)     [###-----------------]  15%  H1 built, in review
Laptop and real-footage checks  [##------------------]  10%  needs the laptop
Whole plan                      [########------------] ~40%
```

The percentages are estimates by the size of each piece, not measurements.

## Done (merged into `main`)

| PR | What |
|---|---|
| #1–#4 | Phase 0: classic editor restored and stripped, Premiere names, fresh save format, architecture doc |
| #5 | Phase 1: editing API (atomic `apply(ops)`, revision checks, sequence digest) |
| #6–#10 | Phase 2: `splice` server, editor bridge, `splice mcp`, footage referenced on disk, Windows launch fixes |
| #11–#13 | Phase 3a: transcription (whisper.cpp), removal markers with Restore/Swap, rough cut with take removal |
| #14 | Short format with word-by-word burned-in captions |
| #15 | Tighten: pauses, false starts, filler words |
| #16 | Rough Cut loudness to −14 LUFS |
| #17 | Horizontal workflow decisions (`docs/decisions.md`) |
| #18 | Off-by-default noise reduction |
| #19 | Export and playback decode only the source ranges the sequence uses |

## In progress

**PR #20, H1: horizontal captions and MP4/SRT export pairs** (branch `feat/h1-captions-export`)

- [x] Built: SRT cues from audible words, caption list with play and correct, three correction scopes, MP4+SRT pair into `Exports/`, retry, export history, MCP tools.
- [x] CI and CodeRabbit pass; 507 tests pass; browser e2e passes on the devbox.
- [ ] **Round 2: fix the 7 P2 issues from the Codex review** (details with file:line in `logbook.md`, entry 16:00 on 2026-11-24):
  1. Publish both files in one step (stage in a per-export folder, one rename); make retry recover a committed pair instead of duplicating it.
  2. A cue-only correction or hide must affect only that placement, not every reuse of the same source words.
  3. A second project correction of an already-corrected word must take effect.
  4. Validate caption edits (the 1,000-character limit) before saving; bad saved data must not drop the whole captions block.
  5. Load saved spellings at editor start and wait for them before export.
  6. Fix horizontal delivery at 1920×1080, 30 fps, and capture all render inputs with the approved snapshot.
  7. Stop phrase replacements at long pauses, sentence breaks and recording changes.
- [ ] Codex re-verify (sol, medium), CodeRabbit final review, merge.
- [ ] Known limitations to list in the PR: Windows reserved names like `CON.demo`; `captions_correct` checks the revision before it awaits the spelling load.

## Left to do

| Step | Status | What |
|---|---|---|
| H1 | Round 2 | Captions and export pairs (above) |
| H2 | Not started | "Finalize cut" checkpoints, compare with the approved cut, review issues you fix or dismiss, export gate, reopen summary |
| H3 | Not started | Basic graphics pass: zooms, highlights and glass cards as editable edits; manual changes survive reruns and take swaps. The largest piece. |
| H4 | Not started | Final mix: optional music fitted and faded, ducking under speech, whole-mix −14 LUFS with a peak ceiling, picture-only repairs mute replacement audio |
| H5 | Not started | Short styles: Explainer and Raw, caption placement, opening hook |
| H6 | Not started | Cut transcript panel |
| Laptop | Pending | AAC audio in Chrome, Open folder in File Explorer, SRT upload to YouTube, CUDA transcription, `splice mcp` surviving MCP restarts, a real 30–45 min recording on D: (see `LAPTOP-CHECKS.md`) |
| Later | Needs real footage | Local vision comparison (Qwen vs Moondream), screenshot access, HyperFrames trial |

Estimate at the current pace: about 5–8 days of running time for H1–H6.

## How the work runs

- Each milestone is one PR, stacked on the one before it when it depends on it.
- Claude subagents build. Codex (gpt-6.2-sol, medium effort) only reviews.
- Merge bar: no P1 or P2 from Codex, CI green, no major CodeRabbit comments. P3s go into the PR's known limitations.
- Develop and verify on a boxes.dev devbox: lint, typecheck, tests (run from the repo root so `bunfig.toml` preloads the wasm loader), `build:web`, and a headless browser run.
- No co-author trailers. Never commit `AGENTS.md` or `CLAUDE.md`. Never push to `main`; merge through PRs.
- `logbook.md` holds every decision and review round in detail.
