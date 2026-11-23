# Splice

Splice is a browser video editor where an agent makes the rough cut from raw recordings and the creator finishes the edit by hand. It's built on the OpenCut classic editor ([ADR 0001](docs/adr/0001-fork-opencut-classic-and-diverge.md)).

- Vocabulary: [GLOSSARY.md](GLOSSARY.md)
- Settled decisions: [docs/decisions.md](docs/decisions.md)
- Architecture: [docs/agentic-layer-architecture.md](docs/agentic-layer-architecture.md)

## Develop

Requires Bun 1.2.18.

```sh
bun install
bun run dev:web     # http://localhost:3000
bun run typecheck
bun run lint
bun test
```

## Run

Splice runs as two processes, both started by hand.

```sh
bun run build:web   # once, and after pulling changes
bun run splice      # or `bun run splice -- --dev` to run the editor with hot reload
```

`splice` creates its data folder (`D:\Splice` on Windows, `~/Splice` elsewhere) and prints a link like `http://127.0.0.1:7420/projects#splice-token=…`. Open it in Chrome. The token moves from the link into the tab's storage, so later visits to `http://127.0.0.1:7420` stay connected, also after `splice` restarts.

To let an agent edit, register `splice mcp` as a stdio MCP server in your agent (T3 Code, Codex, Claude Code):

```json
{ "command": "bun", "args": ["<path to this repo>/apps/server/src/cli.ts", "mcp"] }
```

`splice mcp` connects to the running `splice` and starts it in the background if it isn't running. Its tools are `editor_status`, `sequence_get` and `sequence_apply`. `bun run splice link` prints the editor link of a running `splice`, for example one that `splice mcp` started. The editor header shows whether an agent is connected, and **Stop agent** refuses its edits until you allow them again.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPLICE_ROOT` | `D:\Splice` (Windows), `~/Splice` | Data folder |
| `SPLICE_PORT` | `7420` | Port you open; the editor's own server uses the next one |
