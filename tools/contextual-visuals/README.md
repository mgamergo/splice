# Contextual visuals prototype

The browser previews a 72-second interview excerpt and presents three suggestions from its transcript. Add, remove, or move a suggestion, trim the opening, and export the resulting sequence. The browser and server share the animation logic. FFmpeg and a CPU canvas on the devbox produce the final H.264 and AAC MP4.

## Run the demo

Use Bun 1.2.18, FFmpeg with libx264, and a recent Chromium browser.

```sh
cd tools/contextual-visuals
bun install --frozen-lockfile
bun run prepare:media
bun run dev
```

Open http://127.0.0.1:4173 on the devbox or through its private port forward. The demo serves one excerpt and a reviewed model result. The review tightened the graphic copy and moved two anchors to the phrases that support them. It accepts one export at a time.

## Regenerate suggestions

Extract 16 kHz mono audio from the original file. Run whisper.cpp v1.8.2 with the English Base model and the `-oj` option to create a JSON transcript. The saved result corrects Whisper's rendering of “Bangla” using the original interview description. Run llama.cpp build b12651 with Qwen2.5-3B-Instruct Q4_K_M, CPU threads, and a loopback listener on port 8091. Run the analyzer with that transcript.

```sh
bun run analyze /path/to/transcript.json
```

The analyzer selects the excerpt range from the source timestamps and saves its proposals in `fixtures/analysis.json`. The browser loads that file through the dev server. Regenerating replaces the reviewed copy with fresh model output. Restart the server to load it.

## Verify

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
CHROMIUM_PATH=/path/to/chromium bun run test:browser
```

Run the browser test with the demo server listening. It saves viewport screenshots and the exported MP4 under `artifacts/`. The test compares the browser preview with a decoded export pixel during the animated diagram and checks that the diagram is absent from an earlier export frame.

## Footage

The source is [Interview with Jimmy Wales at Wikimania 2025 Nairobi](https://commons.wikimedia.org/wiki/File:Interview_with_Jimmy_Wales_at_Wikimania_2025_Nairobi.webm) by DelwarHossain and Rocky, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The demo excerpts and animates the footage. Source and rendered media stay outside Git.
