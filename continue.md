# Continue here

Where the Splice build stands, and what to do next. Last updated 2026-11-25.

## Progress

```
Core editor and agent pipeline  [####################] 100%  Phases 0–3b, range export
Horizontal workflow (H1–H6)     [####################] 100%  H1–H6 merged
Profile, styles, brief, cleanup [####################] 100%  #29–#34 merged
Laptop and real-footage checks  [##------------------]  10%  needs the laptop
Whole plan                      [################----] ~80%
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
| #20, #21 | H1: horizontal SRT captions, three correction scopes, MP4/SRT pairs published as one folder rename, idempotent Retry |
| #22 | H6: cut transcript panel, `cut_transcript` and `transcript_selection` |
| #23 | Loudness test tolerance with FFmpeg installed |
| #24 | H2: approved checkpoints, compare and restore, review issues with dismissals, export gate, reopen summary |
| #25 | H3: editable zooms, highlights and glass cards, MCP graphics pass, reruns keep creator edits, flags in review |
| #26 | H4: music, ducking with app-sound overrides, picture-only repair, mastered mix (−14 LUFS, −1 dBTP) in bounded blocks |
| #27 | H5: Short styles Explainer and Raw, opening hook, caption placement, vertical MP4 with optional SRT |
| #29 | Project brief, teaching-order guard with one explicit `restructure` flag, `sequence_preview_ops` and scoped edits |
| #30 | Editing profile 1: correction capture with a persisted outbox, `corrections.jsonl`/`pending.jsonl`, `profile.md`, `profile_read`/`profile_pending`/`profile_apply` |
| #31 | Style defaults per project with an Update style preview, framing preferences with evidence and revert |
| #32 | Cleanup: Storage panel, `storage_report`/`storage_cleanup` (preview token, revalidated deletes, no recursive rm) |
| #33 | Editing profile 2: idle profile agent, one question per batch, Profile panel with per-update revert, OpenAI-compatible and opt-in CLI providers |
| #34 | Recording verification on relink: full-content digest for moved or rewritten files, explicit replacement, affected passages flagged |

## Known limitations (from the PRs)

- Windows reserved names like `CON.demo` in export stems.
- After a razor split, a cue edit falls back to the transcript words if the same words are heard more than once.
- Exports made before #21 stay as loose files in `Exports/`; legacy checkpoints use path, size and modification time until reapproved.
- Graphics: no local vision or moving-target tracking yet; highlights sample the picture transform at their midpoint.
- Final mix: older mixes keep baked-in ducking until refit; music stays ducked over untranscribed recordings.
- Shorts: automatic caption placement uses H3 targets and presets, so crowded frames can need manual placement; legacy Raw hooks keep their timing until set again.
- Profile: only one `splice` server per profile root; free-form MCP and legacy `profile.md` text revert as one field; CLI provider terms need the creator's confirmation (see #33); live provider sign-in unverified.
- Cleanup: on POSIX a same-name replacement inside `Cache` can race the final check; Windows and macOS unverified.
- Relink: approvals and transcripts keyed only by the older sampled fingerprint may need reapproval or retranscription; accepting a replacement resets undo.
- Brief: one-take sections from older cuts must be declared again to be protected.
- Headless Chromium renders black frames with `--disable-vulkan-surface`; that is the environment, not Splice.

## Left to do

| Step | Status | What |
|---|---|---|
| CI | Broken | GitHub Actions stopped starting runs on 2026-11-24 16:39 (Actions enabled, status page green). Check the repo's Actions tab and account billing. Until then, merges use the local gate below. |
| Laptop | Pending | AAC audio in Chrome, Open folder in File Explorer, SRT upload to YouTube, CUDA transcription, `splice mcp` surviving MCP restarts, a real 30–45 min recording on D: (see `LAPTOP-CHECKS.md`) |
| Creator | Decide | Confirm the CLI provider terms recorded in #33 before enabling `codex exec` / `claude -p` |
| Later | Needs real footage | Local vision comparison (Qwen vs Moondream), screenshot access, HyperFrames trial, gaze-continuity and missing-action checks, moving-target tracking, real-footage pass over the H2–H5 and profile flows |

## How the work runs

- Each milestone is one PR, stacked on the one before it when it depends on it.
- Codex gpt-6.2-sol workers (high effort) build and fix; this thread only orchestrates. At most 3 workers at a time, and each worker's T3 worktree is deleted when it finishes (T3 never deletes them).
- One Codex review round per PR (gpt-6.2-sol, medium). Workers fix the P1/P2s, then the PR merges without a second review and without waiting for CodeRabbit. P3s go into the PR's known limitations.
- If gpt-6.2-sol is missing, update the Codex CLI (`npm i -g @openai/codex@latest`; 0.160.0 lacked it).
- Local CI gate (while Actions is down): a clean detached worktree at the PR head, `bun install --frozen-lockfile`, `typecheck`, `lint` (0 errors), `bun test` from the repo root, `build:web`. Heavy steps share `flock /data/tmp/claude-1000/locks/heavy.lock` on the 4 vCPU / 8 GB instabox.
- No co-author trailers. Never commit `AGENTS.md` or `CLAUDE.md`. Never push to `main`; merge through PRs.
- `logbook.md` holds every decision and review round in detail.
