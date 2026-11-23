# Laptop checks

Checks that can only run on the creator's laptop (Windows, Radeon 860M, RTX 5050). A PR that adds an entry under **Pending** gets the `needs-laptop` label and waits for the creator to verify and merge it. When a check passes, move it to **Verified** with the date and the commit it was verified on.

## Pending

- **Footage on `D:` plays** (Phase 2; synthetic 40-minute 1080p and a stock clip played on `5457d86f` with about 930 MB extra Chrome memory, and large seeks froze the preview for a few seconds; still needs a real recording). Put a real 30–45 minute 1080p recording in `D:\Splice\Footage\` (in a subfolder with spaces in its name), `items_import` it, add it to the timeline and play and scrub it in Chrome on the Radeon 860M. Playback is smooth, the waveform appears, and Task Manager shows no multi-gigabyte jump in Chrome's memory.
- **`splice mcp` from T3 Code** (Phase 2; failed on `5457d86f` because the background `splice` died when T3 Code restarted its MCP server, so re-check after the fix that launches it outside the MCP process tree). With `splice` not running, the first `editor_status` call starts it in the background. After opening the link, `sequence_apply` with an `add_marker` op shows the marker on the timeline straight away. The background `splice` keeps running when T3 Code restarts the MCP server.

## Verified

- **`splice` on Windows** (Phase 2). Verified 2026-11-23 on `5457d86f`. After `bun run build:web`, `bun run splice` ensured all six `D:\Splice\` folders and printed the editor link. Laptop Test showed "Agent connected" in Google Chrome on the Radeon 860M.
- **Clean shutdown on Windows** (Phase 2). Verified 2026-11-23 on `5457d86f`. Ctrl+C in the `splice` terminal ended the Next.js server. Port 7421 had no listener and no Splice `node` or `bun` process remained.
