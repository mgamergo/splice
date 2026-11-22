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
bun run lint:web
bun test
```
