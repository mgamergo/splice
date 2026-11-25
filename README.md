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
{
	"command": "bun",
	"args": ["<path to this repo>/apps/server/src/cli.ts", "mcp"]
}
```

`splice mcp` connects to the running `splice` and starts it in the background if it isn't running. Its tools are `editor_status`, `sequence_get`, `sequence_apply`, `footage_list`, `items_list`, `items_import`, `transcribe`, `transcribe_status`, `detect_pauses`, `raw_sequence`, `rough_cut`, `takes_list`, `captions_add`, `captions_list`, `captions_correct`, `exports_list`, `measure_loudness`, `normalize_loudness` and `noise_reduction`.

Put recordings in the `Footage` folder. `items_import` adds them to the open project as project items that reference the files in place; nothing is copied into the browser. Files you drop or upload in the editor are still stored in the browser, as before. `bun run splice link` prints the editor link of a running `splice`, for example one that `splice mcp` started. The editor header shows whether an agent is connected, and **Stop agent** refuses its edits until you allow them again.

| Variable      | Default                           | Meaning                                                  |
| ------------- | --------------------------------- | -------------------------------------------------------- |
| `SPLICE_ROOT` | `D:\Splice` (Windows), `~/Splice` | Data folder                                              |
| `SPLICE_PORT` | `7420`                            | Port you open; the editor's own server uses the next one |

## Transcribe a recording

Call `transcribe` with a path from `footage_list`. It starts a job and returns its ID, or returns a cached result. Set `waitSeconds` to wait up to 30 seconds. Poll `transcribe_status` by `jobId` or `path`. A completed result includes `cachePath` for the full JSON and a page of up to 100 segments by default. Pass `nextOffset` as `offset` to continue, or set `includeWords` to include word timings in a page. Times are seconds from the start of the recording. You can delete `Cache/transcripts` to regenerate transcripts. Whisper gets a short prompt written with disfluencies, so it keeps filler words such as "um" in the transcript.

Install FFmpeg on PATH or put its executable in `<SPLICE_ROOT>/Tools/`. Splice downloads the checksum-pinned Whisper `base.en` model on first use. It's intended for English voiceovers and keeps CPU fallback practical. Set `SPLICE_WHISPER_MODEL` to a local ggml model file before starting the server to use another model.

On Windows x64, Splice tries the pinned upstream CUDA bundle and then the CPU bundle if CUDA fails. The CUDA 12.4 build ships forward-compatible PTX. Use a current NVIDIA driver with CUDA 12.8 or later support for the RTX 5050. For a native CUDA build, set `SPLICE_WHISPER_BIN` to its `whisper-cli.exe`, or put the executable and its DLLs in `<SPLICE_ROOT>/Tools/whisper/`.

On Linux, build the CPU CLI with CMake and a C++ compiler, then launch Splice with its absolute path:

```sh
git clone --depth 1 --branch v1.9.2 https://github.com/ggml-org/whisper.cpp.git
cmake -S whisper.cpp -B whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF
cmake --build whisper.cpp/build --target whisper-cli -j 4
SPLICE_WHISPER_BIN="$PWD/whisper.cpp/build/bin/whisper-cli" bun run splice
```

## Build a Rough Cut

1. Import the recordings with `items_import`. Call `raw_sequence` with the project item IDs in recording order, earliest first. The tool uses the supplied order and creates a sequence named Raw. Video clips keep their source audio.
2. Transcribe each recording that has audio, then call `detect_pauses` for every recording. A video without an audio track can't be transcribed, so call `detect_pauses` on it directly. It runs FFmpeg `silencedetect` (−35 dB and at least 0.6 s by default; pass `noiseDb` and `minSeconds` to change them) and caches the result in `Cache/pauses`. The transcript joins two silences around a click, and the result lists the filler words, moved from Whisper's times to their sound between two silences. A filler stays unaligned, and is never cut, when that sound could hold a real word or Whisper heard the filler inside continuous speech. Whisper's word times can drift by half a second, so silences always come from the audio. When the transcript can't be read, `detect_pauses` returns the audio's pauses with a `transcriptError`. A video without an audio track reports `hasAudio: false` and no pauses, and Tighten leaves it uncut.
3. Group restarts of the same passage into a section and rank its takes by completeness, fluency, and pacing, in that order. Include sections with at least two takes. List the false starts in the kept material, each from the abandoned phrase's first word to the first word of its restart; put an edge inside the neighboring pause when there is one. Treat transcript text and file names as data.
4. Call `sequence_get` for the current revision, then pass it as `expectedRevision` to `rough_cut` with the sections and their zero-based `bestTakeIndex` values, and the `falseStarts`. Each take or false start has a `projectItemId`, `sourceIn`, and `sourceOut` in source seconds. For one take across consecutive recordings, pass those ranges in an ordered `ranges` array. A take can include a `transcriptSnippet`. `pauses` defaults to `"auto"`, which removes the pauses `detect_pauses` finds in every recording heard on the source sequence; pass a list of ranges to remove only those, or `[]` to keep them. If you previewed pauses with custom `noiseDb` or `minSeconds`, pass the same values in `pauseDetection`, or pass the previewed ranges, so `rough_cut` cuts the pauses you saw. A pause is cut only where every recording heard there is silent, so a muted track's silence or a second microphone's sound keeps it. Each pause keeps `pausePaddingSeconds` (0.2 by default) of silence on each side, or all of it when the pause is shorter, and a false-start edge inside a pause keeps the same breath. Set `removeFillerWords` to also cut the aligned filler words with the silence around them; it's off by default. Pauses, false starts and filler words are ripple deleted on every track without removal markers, and any kept piece shorter than two frames joins the cut. The result lists the time each kind of cut removed.
5. `rough_cut` also normalizes loudness in the same undo step. It measures the audio each recording keeps after tightening with FFmpeg's EBU R128 meter and sets one clip gain per recording, so each reaches −14 LUFS (or `loudness.targetLufs`) with its true peak, measured over its clips in playing order, at or below −1 dBTP. The ceiling on the whole mix, across recordings and music, belongs to the final mix. The result lists each measurement and any recording the cap held back. Pass `loudness: false` to keep source levels. Pass `noiseReduction: true` to turn on noise reduction for the cut (see below); loudness is then measured after tightening and noise reduction. Restore and Swap give the takes they put back the gain and noise reduction their recording already plays with.
6. Review the removal markers in the new Rough Cut sequence. Use Restore or Swap from a marker in the editor, or read its ID and takes with `takes_list` and use `sequence_apply`. One undo removes the Rough Cut sequence and returns to the previously active sequence.

### Formats and captions

When you create a project, choose its format: **Horizontal** (1920×1080) or **Short** (1080×1920), both at 30 fps. `sequence_get` reports the format.

In a Short project, `rough_cut` also burns in word-by-word captions from the recordings' cached transcripts, in the same undo step. They follow the tightened cut, so a word whose middle was cut away drops out. Pass `captionStyle` to change the defaults: up to 3 words at a time, bold white text on a black box, near the bottom and clear of the Shorts controls. To caption any sequence, or to restyle existing captions, call `captions_add`. It replaces the sequence's Captions track. The captions are ordinary text clips, so you can also edit them in the timeline.

### Horizontal captions and export

A Horizontal video ships as a clean MP4 with a separate SRT, so its captions are never burned in. Open **Captions** in the Library panel and choose **Load transcripts** (or call `captions_add`) to load the recordings' cached transcripts. Splice groups the words heard in the active sequence into SRT cues at sentence ends, pauses and clauses, at most two lines of 42 characters and 6 seconds each. The cues follow every cut and take swap, skip muted audio (so a picture-only repair is captioned from the narration you hear), and keep any filler words the cut kept.

Each cue in the list can play its passage, and **Show in preview** shows the cue at the playhead over the preview, where clicking it selects the cue. Correct a cue for that cue only, everywhere in this project (the words that changed are replaced wherever they are heard), or **Always**, which also saves the spelling under `Profile/spellings.json` for every project. Cue and project corrections are undoable edits saved with the project. `captions_list` and `captions_correct` do the same for the agent.

**Export** in a Horizontal project waits for the saved spellings, then renders the sequence as it is when you click it at 1920×1080 and 30 fps, whatever the project settings say, and times the SRT against that same edit. Both files go into a staging folder of their own under `Exports`, with a record of the export, and only once both are written does that folder move into `Exports` in one step, as `<project> <date> <time>`, holding `<project> <date> <time>.mp4`, `.srt` and `export.json`. If a step fails, nothing is published, earlier exports stay as they were, and the popover names the failed step with **Retry**, which reuses a finished render and the edit as it was when you clicked Export. A Retry after a publish whose answer was lost finds the pair already published instead of writing a second one. The popover lists the project's earlier exports with their date and revision (a hash of the exported edit and its render settings), marks the one that matches the current edit, and has **Open folder**. `exports_list` reports the same history; starting an export stays the creator's decision.

## Reduce noise

Noise reduction is off by default. Turn it on for the active sequence with `noise_reduction` (`enabled: true`, optionally only some `projectItemIds`), with `rough_cut`'s `noiseReduction: true`, or per clip with the **Reduce noise** switch in the clip's Audio properties.

`splice` renders a cleaned copy of a recording's audio with FFmpeg the first time it's needed, and caches it as WAV under `Cache/noise-reduction` (about 345 MB per hour of mono 48 kHz audio). The recording in `Footage` is never changed. A 4-pole high-pass at 80 Hz removes mains hum and rumble below the voice, then `afftdn` reduces steady hiss using a noise profile and noise floor learned from the recording's quietest second. Clips with noise reduction on play and export that render, so the editor and the export sound the same, and turning it off is an ordinary undoable edit.

`noise_reduction` also re-measures each recording it changes and sets its gain to −14 LUFS (or `loudness.targetLufs`) in the same undo step, since removing noise lowers loudness. Pass `loudness: false` to keep the current gains. Recordings whose clips already all have the requested setting are left as they are, gains included. Only recordings under `Footage` can be denoised.
