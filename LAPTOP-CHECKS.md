# Laptop checks

Checks that can only run on the creator's laptop (Windows, Radeon 860M, RTX 5050). A PR that adds an entry under **Pending** gets the `needs-laptop` label and waits for the creator to verify and merge it. When a check passes, move it to **Verified** with the date and the commit it was verified on.

## Pending

- **Footage on `D:` plays** (Phase 2). On `5457d86f`: a synthetic 40-minute 1080p file and a stock clip played, with about 930 MB of extra Chrome memory, which is acceptable. Large seeks froze the preview for a few seconds on the synthetic file, likely because of x264's default 250-frame keyframe spacing. A real 2-minute on-camera recording played and scrubbed smoothly. Still needs a real long recording. Put a real 30–45 minute 1080p recording in `D:\Splice\Footage\` (in a subfolder with spaces in its name), `items_import` it, add it to the timeline and play and scrub it in Chrome on the Radeon 860M. Playback is smooth, the waveform appears, and Task Manager shows no multi-gigabyte jump in Chrome's memory.
- **`splice mcp` from T3 Code** (Phase 2; failed on `5457d86f` because the background `splice` died when T3 Code restarted its MCP server, so re-check after the fix that launches it outside the MCP process tree). With `splice` not running, the first `editor_status` call starts it in the background. After opening the link, `sequence_apply` with an `add_marker` op shows the marker on the timeline straight away. The background `splice` keeps running when T3 Code restarts the MCP server.

- **Transcription on Windows (CUDA on the RTX 5050, CPU fallback)** (Phase 3a). Install FFmpeg and an NVIDIA driver with CUDA 12.8+ support. Start Splice on the Radeon 860M with `CUDA_VISIBLE_DEVICES=-1`. Call `transcribe` in T3 Code with a fresh recording under `Footage`. Poll `transcribe_status` and check `backend: "cpu"`. To exercise the separate CPU bundle, stop Splice, temporarily rename `Tools/whisper/v1.9.2-cuda/whisper-cli.exe` if installed, and repeat with an uncached recording. Check that `Tools/whisper/v1.9.2-cpu/whisper-cli.exe` runs. Restore the CUDA executable and restart without `CUDA_VISIBLE_DEVICES`. Transcribe a fresh 30–45 minute recording, check for `backend: "cuda"` and RTX compute activity, and spot-check word timings at the beginning, middle, and end. A repeat call should return `cached: true`.

## Verified

- **`splice` on Windows** (Phase 2). Verified 2026-11-23 on `5457d86f`. After `bun run build:web`, `bun run splice` ensured all six `D:\Splice\` folders and printed the editor link. Laptop Test showed "Agent connected" in Google Chrome on the Radeon 860M.
- **Clean shutdown on Windows** (Phase 2). Verified 2026-11-23 on `5457d86f`. Ctrl+C in the `splice` terminal ended the Next.js server. Port 7421 had no listener and no Splice `node` or `bun` process remained.
