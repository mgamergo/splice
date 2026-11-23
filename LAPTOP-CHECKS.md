# Laptop checks

Checks that can only run on the creator's laptop (Windows, Radeon 860M, RTX 5050). A PR that adds an entry under **Pending** gets the `needs-laptop` label and waits for the creator to verify and merge it. When a check passes, move it to **Verified** with the date and the commit it was verified on.

## Pending

- **`splice` on Windows** (Phase 2). After `bun run build:web`, `bun run splice` creates `D:\Splice\` with `Footage`, `Projects`, `Cache`, `Profile`, `Exports` and `Tools`, and prints the editor link. Opening it in Chrome on the Radeon 860M shows "Agent connected" in the editor header after creating a project.
- **Clean shutdown on Windows** (Phase 2). Ctrl+C in the `splice` terminal also ends the editor's Next.js server: nothing is left listening on port 7421 (`netstat -ano | findstr 7421`).
- **Footage on `D:` plays** (Phase 2). Put a real 30–45 minute 1080p recording in `D:\Splice\Footage\` (in a subfolder with spaces in its name), `items_import` it, add it to the timeline and play and scrub it in Chrome on the Radeon 860M. Playback is smooth, the waveform appears, and Task Manager shows no multi-gigabyte jump in Chrome's memory.
- **`splice mcp` from T3 Code** (Phase 2). With `splice` not running, the first `editor_status` call starts it in the background. After opening the link, `sequence_apply` with an `add_marker` op shows the marker on the timeline straight away. The background `splice` keeps running when T3 Code restarts the MCP server.

## Verified

_None yet._
