# Project items reference files on disk

Project items point to source files on the creator's disk (a drive dedicated to Splice), which the local Splice server streams to the editor tab. They are not copied into browser storage, as OpenCut classic does.

Raw recordings run 30–60 minutes at 1080p, so a copy in browser storage would double several gigabytes per video. The transcriber (whisper.cpp) also needs a real file path, which a browser never exposes. Pointing at the file gives one copy that the editor, the transcriber and the agent all read.

## Consequences

- Moving, renaming or deleting a source file breaks the project. The editor must detect missing files and offer to relink them.
- The editor depends on the local server to play media, so it can't work as a standalone web page.
- Classic's media storage code and its migrations are replaced, not kept.
