# Fork OpenCut classic and diverge from upstream

Splice is built on OpenCut's classic browser editor (`opencut-app/opencut-classic@cf5e79e`), not on upstream OpenCut's in-progress Rust rewrite. The fork's `main` is reset to that commit and maintained independently, and upstream is no longer tracked.

We chose this because the rewrite had no editing engine to drive yet. Classic already provides a complete timeline with undoable commands, which lets an agent edit live in the same tab the creator uses. Shotcut was rejected because it has no live control interface. Kdenlive was rejected because live control would mean maintaining a patched C++/Qt fork. Blender's video editor was rejected as a poor fit for fast finishing edits. Building from scratch was rejected because it would take months to match the editing interface classic already has.

## Consequences

- Upstream fixes and features will never merge cleanly. Splice owns every line it keeps.
- The Rust/WASM core stays on the published `opencut-wasm` npm package until a feature needs Rust changes.
- Everything that isn't the editor is removed, including the marketing site, blog, auth and feedback.
