# Splice logbook

## 2026-11-23 evening (autonomous, creator asleep)

- 18:00 UTC: Claude 5-hour limit reset.
  - Four builders had died on the limit: #15 fixes, #16 fixes, range export, noise reduction.
  - Their uncommitted work was saved to `wip/tighten-review-fixes`, `wip/loudness-review-fixes` and `wip/range-export`.
  - Noise reduction had pushed 2 commits to `feat/noise-reduction`, with no PR yet.
- Decision: use Claude sparingly, as asked.
  - At most two Claude builders run at once.
  - Codex stays verification-only.
  - Order: #16 fixes (it has a P1), then #15 fixes, then range export and noise reduction, then the horizontal workflow from `docs/decisions.md`.
- Opened PR #17 for `docs/horizontal-workflow`. It merges on CI alone, without CodeRabbit, as instructed.
- Decision on #14: CodeRabbit kept finding narrower cases in the caption rebuild. The latest needs two captions hand-dragged into a stacked run's hold right at an edit edge.
  - Without knowing which word each caption belongs to, a dragged caption there looks exactly like a staggered caption.
  - Recorded it as a known limitation, and merge #14 once checks pass.

### Build plan for the horizontal workflow (docs/decisions.md, "End-to-end editing workflow")

This is the order I'll build it in, one PR per milestone and stacked where needed. Export comes first because every delivery depends on it.

0. Range-limited export: finish `wip/range-export`.
1. H1, horizontal captions and export pairs:
   - SRT cue grouping at phrase boundaries, keeping deliberately kept fillers.
   - Caption list with play and correct, plus preview overlay.
   - Correction scopes: cue, project, or reusable spelling.
   - Export writes the MP4 and SRT with one stem into `Exports/` on the Splice root, from one approved sequence revision.
   - Export history with an Open folder action.
   - Publish both files only after both succeed, keeping the previous pair on failure.
2. H2, approval and review:
   - Finalize cut saves an approved checkpoint.
   - Compare against it.
   - The export gate lists unresolved issues to fix or dismiss.
   - Reopen summary.
3. H3, basic graphics pass as editable sequence edits:
   - Zoom/crop keyframes, highlight boxes and glass cards, each linked to a passage, source frames and a target.
   - Manual adjustments are tracked per property and survive reruns and take swaps.
   - Flag a graphic when its action is removed.
4. H4, final mix:
   - Opt-in music, fitted and faded.
   - Ducking under speech.
   - Whole-mix −14 LUFS with a peak ceiling.
   - Picture-only repair mutes replacement audio.
5. H5, Short styles (Explainer and Raw): caption placement and hook.
6. H6, cut transcript panel.
7. Later, needing the laptop or real footage: local vision evaluation (Qwen vs Moondream), screenshot access, the HyperFrames trial, and the 30–45 minute laptop test.
- #17 merged as 6c6e28a (CI and CodeRabbit both clean).
- #16 review fixes pushed (e6ba129). Codex re-verification started. The freed Claude slot went to range export, picking up wip/range-export.
- #15 review fixes pushed (11035a32). Codex re-verification started. The freed Claude slot went to finishing noise reduction: merge feat/loudness in, then open a stacked PR.
- #15 Codex re-check: changes requested again (filler alignment off by 10 ms; swap-back placement across 3 recordings; P3 tie-break). Queued for the next free builder.
- #16 second Codex round (P1 long-repeat join, P2 quadratic graph, P3 fixture spaces): fixed myself. The meter now uses an ffconcat range list (2dd1e81, 2bc9800). The noise-reduction builder will need to merge feat/loudness again.
- #14 merged (CI, CodeRabbit check and box e2e all green on b509fcc).
- #16: merged main into feat/loudness (rough_cut now captions Shorts and normalizes in one undo step; MCP tests updated, plus a combined Short+loudness test). Checks and the Short e2e are running on wip/loudness-merge before I fast-forward feat/loudness. #15 also conflicts with main; its next fix builder will merge main first.
- #16, third Codex round:
  - Fixed: video ranges are now measured from a cached audio-only stream copy, and ranges are measured in playing order.
  - Decision: the per-recording gain can't guarantee the −1 dBTP cap at joins. Joins with other recordings and music, and the packet overrun at range ends, are out of its reach.
  - The guarantee belongs to the final-mix ceiling (decisions.md, H4). The wording now says that, and the remaining packet-overrun case is a known limitation.
  - Merged main in. rough_cut now captions Shorts and normalizes loudness in one undo step.
  - Head 4f89622. Box checks and the Short e2e are green.
- #16 merged (CI, CodeRabbit check and box suite green on 9065357). Remaining known limitation: packet overrun at joins; the final-mix ceiling covers it.
- #18 noise reduction opened against main (3812b2d). Codex verification started. The freed Claude slot went to #15 round 3: merge main in, then fix 2 P2s and a P3.
- #18: CodeRabbit raised 6 actionable comments plus 2 outside the diff (2 Major: noise_reduction gains changed for unchanged recordings; rough-cut gains should key on noise-reduction state). These will be batched with the Codex results into one fix builder when a slot frees.
- #18 Codex: request changes. P2 gains keyed by item only (mixed denoised/plain clips); P2 swap/restore loses the saved denoise when a plain clip of the same recording remains; P3 stale render when size and mtime are unchanged; P3 WAV over 4 GiB needs RF64. Evidence in /data/home/.t3/projects/splice-pr18-evidence. Queued with the CodeRabbit findings for one builder.
- #19 range export opened (02b93d5): reads 4.28 GB → 315 MB, peak memory 3.9 → 2.1 GB, stale-first-frame bug fixed. Codex verification started. The freed Claude slot went to the #18 fixes (Codex plus CodeRabbit findings).

## 2026-11-24 01:05 UTC — resumed after Claude reset
- #19: box checks on main-merge 7951da21 green (install/types/lint/tests, 299 pass) → pushed to perf/range-export, deleted wip/range-export-merge. Claude builder started on Codex P2/P3 + CodeRabbit findings.
- #15: failed builder left 3 unpushed commits (round-3 fixes + main merge) plus a lint-fix diff in the swap-back test. Committed the diff, pushed as wip/tighten-round3 (0612c04b); box checks running. If green, fast-forward feat/tighten to it (normal push).
- #18: re-ran the failed fix builder (Codex 2×P2, 2×P3 + 6 CodeRabbit + 2 outside-diff).
- Decision: at most 2 Claude builders at once (#18, #19); #15 finishing is done by hand since only checks remain.
- 01:40 Codex round 4 on #15 @0612c04b: round-3 fixes confirmed; new: P2 muted-track silence drives pause cuts (editor-api.ts:189), P2 filler overlapping a word by 5 ms still cuts it (pauses.ts:264), P3 overlay boundary leaves <2-frame Main fragment (tighten.ts:202). Queued a Claude builder for when a slot frees (max 2 concurrent).
- #19 CodeRabbit re-review on the builder's mid-fix pushes: fetch mock type (already fixed in 8619a52); NEW minor: dispose the disk input when the signal aborts in decodeAudioRange (audio.ts). Hand it to the next round if the builder misses it.
- 01:55 #18 builder done (f110b788, all 12 findings fixed, CI+box green). Codex verify on box ~/splice-verify16 (repurposed; ~/splice-verify18 is only a scratch dir, not a repo). #15 round-4 Claude builder started.
- #15 CodeRabbit round on 0612c04 (3 actionable): skip filler alignment on auto-pause path (pauses.ts), keep pause detection working if transcript lookup fails (server.ts:143), README: skip transcription for no-audio recordings, + review body: rough-cut.ts:55 measure loudness on the audio the apply pass uses. Queue for after round-4 builder.
- #18 CodeRabbit re-review on f110b78: NEW minor removal-takes.ts keep saved gain paired with its noise-reduction state (plain clips with keyframed volume); NEW outside-diff loudness.ts:450 denoised measurement cache key should use inode+ctime too. Hold for Codex verdict, then one fix round.
- 02:20 Codex on #18 @f110b788: Request changes, 4×P2: sampled denoise trim on timestamp-gap input (noise-reduction.ts:207); stale loudness measurement after denoised WAV refresh (loudness.ts:448, same as CodeRabbit outside-diff); swap-back overwrites saved NR+gain (removal-takes.ts:181, overlaps CodeRabbit minor); disappearing recording mid-render still aborts (noise-reduction.ts:314). Queued round-2 builder for next free slot.
- 02:35 #19 builder done (8619a52, 7 findings, browser preview check passes; pre-roll effect not measurable in fixture). I added e9d92b28: dispose the mediabunny Input on abort (CodeRabbit minor). #18 round-2 builder started. Codex verify of #19 queued (delegate cap 2).
- 02:50 #15 round-4 builder done (d9e352a1; behaviour: pause cut only where all audible recordings silent — music bed blocks pause cuts; hasAudio-unset video counts audible). Codex verify of #19 @e9d92b28 started. Queued: #15 builder for 4 CodeRabbit minors (pause-only path w/o filler alignment; transcript lookup failure → audio-only pauses; README transcribe only audio recordings; apply pass must reuse plan pass's pause ranges for loudness), then Codex verify of #15 round 4+minors together.
- 03:05 #18 round-2 builder done (75a81a6b; NR version 4, loudness key v5, swapped takes always save NR+gain). #15 CodeRabbit-minors builder started. Queued: Codex verify #18 round 2.
- #15 CodeRabbit Major on d9e352a (thread 4674394485, rough-cut.ts): keep pause cuts bound to the placement that passed the audibility check (same source range placed twice → cut at both). Matches the round-4 builder's noted limitation. Queue for next #15 round.
- 03:20 Codex on #19 @e9d92b28: Request changes — P2 range assembler treats ms-rounded packet timestamps as exact (inserts zeros/overwrites; source-range.ts:100); P2 quick export restart → two jobs on shared canvas (export-button.tsx:52, project-manager.ts:192); P3 cancel waits on stalled UrlSource fetch (audio.ts:327, media-data.ts:11); P3 decode tail makes empty range nonempty (source-range.ts:34). Queued #19 round-3 builder; Codex verify #18 round 2 started first.
- 03:40 Codex on #18 @75a81a6b: Request changes — P2 swap-back of a take split into clips with different NR/gain collapses to one setting (removal-takes.ts:937; save per source subrange); P3 loudness revalidation renders denoise before rejecting stale (loudness.ts:484; compare identity first). Queued #18 round-3 builder. #19 round-3 builder started.
- #15 CodeRabbit Major (thread 4674490346, rough-cut.ts): uncached automatic pause scans can outlast the server's 120 s idle timeout before editor.roughCut returns a plan. Queue with the placement-binding Major for next #15 round. CodeRabbit auto-paused #15 reviews.
- 04:00 #15 minors builder done (1df49a9a: pauseRanges() pause-only path; audio-only fallback with transcriptError; plan returns 'tightening' ranges, apply reuses them; README). Left: CodeRabbit short-gap silence join note. #18 round-3 builder started. Queued: #15 round-5 builder (2 Majors: placement-bound pause cuts; 120 s idle timeout on uncached scans) then Codex verify of #15.
- 04:30 #18 round-3 builder done (8e35c0df: per-subrange audio settings in placements, identity-first loudness recheck; 330 pass). Codex verify #18 round 3 next.
- 04:55 Codex on #18 @8e35c0df: Request changes — P2 mixed inline+extracted split take routes both halves to the (muted) extracted track on swap/restore (removal-takes.ts:1050; save route per stretch); P3 add_marker accepts unordered offsets → duplicated audio (ops.ts:65; validate strictly increasing). DECISION: keyframed volume envelopes and clip speed not preserved by swap/restore are pre-existing swap/restore limitations unrelated to noise reduction → record as known limitations in the PR, not blockers. Queued #18 round-4 builder for P2+P3 only. #15 round-5 builder started.
- 05:05 #19 round-3 builder done (59dbb7d3; 2 ms timestamp snap, ExportJobs per-export AbortController, signal into UrlSource fetchFn, empty range before tail; 311 pass; preview + restart browser checks pass). Codex verify #19 round 3 started.
- #18 CodeRabbit on 8e35c0d: Major ops.ts reject out-of-order audioSegments (= Codex P3); outside-diff minors: ops.ts:262 document rough cut inherits NR; removal-takes.ts:318 don't mark restored browser media denoised; removal-takes.ts:135 exclude muted clips from inherited NR vote. Add all to #18 round-4 builder.
- 05:30 Codex on #19 @59dbb7d3: Request changes — P2 stalled video read blocks export restart (pass signal via SequenceExporter/VideoCache to createMediaSource; video-cache/service.ts:267); P3 2 ms snap erases real small gaps in sample-accurate tracks (use track timeResolution; source-range.ts:119); P3 completed export overwrites replacement state (job ID through result publication; project-manager.ts:215). Also 3 CRLF lines. Queued #19 round-4 builder. #18 round-4 builder started (Codex P2 route per stretch, P3 ordered offsets, 3 CodeRabbit minors, PR known-limitations note).
- 05:50 #15 round-5 builder done (678ead7e: per-placement pause cuts; rpc-client fetch timeout:false (server already exempt from idle timeout); short-gap join blocked by nearby word; 375 pass). Codex verify #15 (rounds 4+minors+5) started.
- 06:00 Claude 5-hour limit hit again ~05:55; the #19 round-4 builder failed before changing anything (no WIP). Reset at 06:00; restarted it.
- #18 round-4 builder done before the limit (eab2ea7: route per stretch, ordered offsets, NR docs, Footage-only NR on restore, muted clips out of vote; known-limitations note in PR). Codex verify #18 round 4 next.
- Codex on #15 @678ead7e: Request changes — P2 library music (no mediaId) ignored → pause cuts remove audible music (loudness.ts:42); P2 sliver widening/joining across pauses deletes a preserved 40 ms word (rough-cut.ts:427, tighten.ts:284); P2 no deadline anywhere → stalled server leaves RPCs pending forever (rpc-client.ts:29, server.ts:547); P3 repeated placements borrow padding edges across placements (rough-cut.ts:244/405); P3 apply sends explicit ranges twice → 'Request too large' (mcp.ts:440). DECISION for the deadline: bounded per-method deadlines (short default, long for scans/imports/rough cut) with cancellation, instead of no timeout. Queued #15 round-6 builder.
- 06:15 User: all Codex tasks use sol on medium effort, never astra. The running #18 verify (started on high) is left to finish.
- 06:40 Codex on #18 @eab2ea75: 2 P2s, both about marker formats saved by intermediate branch commits (8e35c0df) — audioSegments never reached main (verified). DECISION: skip as not applicable; no migration for unreleased formats. Requested CodeRabbit resume+review; merge #18 once CodeRabbit has no actionable comments and checks pass.
- 06:40 Codex on #18 @eab2ea75: 2 P2s, both about marker formats saved by intermediate branch commits (8e35c0df) — audioSegments never reached main (verified). DECISION: skip as not applicable; no migration for unreleased formats. Requested CodeRabbit resume+review; merge #18 once CodeRabbit has no actionable comments and checks pass.
- 07:20 CodeRabbit final review on #18 @eab2ea7: 1 outside-diff Major (noise_reduction reads audioSources twice without checking same sequence). Fixed myself in 4357dbcc (refuse when sequenceId differs) + test. Box checks running; then merge #18.
- 07:45 MERGED #18 (noise reduction) after CodeRabbit clean + checks green on 4357dbcc.
- 08:05 #15 round-6 builder done (af3324e5: heardClips blocks pause cuts under unscannable audio; sliver widening limited to silence/cut material; per-method RPC deadlines 30 min for imports/rough cut/scans/measures, 2 min otherwise, abort kills shared FFmpeg via shared-work.ts; per-placement padding; apply sends tightening once; 384 pass). Conflicts with main after #18 in 9 files → merge-main builder started. Codex verify #15 after that (sol medium).
- 08:40 #15 main merge done (b2b3cd55; 433 pass; noiseReduction.render added to the 30-min deadline list). Codex verify #15 (rounds 6 + merge) started, sol medium.
- 09:10 Codex (sol medium) on #15 @b2b3cd55: Request changes — P2 denoise render not cancelled when last caller aborts; P2 >5,000 kept ranges per recording fail loudness INVALID_PARAMS; P2 pause cache key lacks inode/ctime → stale pauses after same-size replace; P3 shutdown doesn't await cancelled work cleanup; P3 tab bridge 10-min deadline undercuts 30-min client deadline for imports. Round-7 builder started. Note: #15 has had 7 review rounds; findings are shrinking toward edge cases in the newly added deadline/abort machinery.
- 09:40 #19 round-4 builder done (3e538006: export signal through SequenceExporter/VideoCache; job IDs in ExportJobs; snap bounded by track timeResolution; LF on changed lines; 314 pass; preview/restart/stalled-restart browser checks pass). Main merge conflicts in audio.ts/media-data.ts (clipAudioMedia sourceKey vs range decode) → merge builder started; then Codex verify (sol medium).
- 10:30 #15 round-7 builder done (68f6a3f7; 442 pass). DECISION: merge bar for #15 going forward = no P1/P2; remaining P3s get listed as known limitations in the PR rather than another round, since review rounds keep surfacing narrower edge cases. Codex verify round 7 started (sol medium).
- 11:00 Codex (sol medium) APPROVED #15 @68f6a3f7; one P3 (pause work admitted after shutdown settles) recorded as known limitation in PR body. Committing logbook.md with #15, then CodeRabbit final review, then merge.
