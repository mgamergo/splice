# Splice

Splice is a video editor where an agent edits the timeline live: it makes the rough cut from a creator's raw recordings, and the creator then finishes the edit by hand. Splice uses Adobe Premiere Pro's vocabulary.

## Language

### Structure

**Project**:
The top-level container for one video's work: its project items, sequences and settings.

**Sequence**:
An ordered arrangement of clips on tracks that plays back and exports as one video.
_Avoid_: Scene, timeline (as a noun for the data), composition

**Timeline panel**:
The panel where the active sequence's tracks and clips are viewed and edited.

**Library panel**:
The tabbed panel beside the preview that holds the project items tab and the libraries of sounds, text, stickers, effects and captions to add to a sequence.
_Avoid_: Assets panel, media panel

**Track**:
A horizontal lane in a sequence, either a video track (V1, V2…) or an audio track (A1, A2…), that holds clips.
_Avoid_: Layer, lane

**Project item**:
Anything imported into or created in the project panel, such as footage, audio, images or graphics, that can be placed in a sequence.
_Avoid_: Asset, media asset, file

**Clip**:
One instance of a project item placed on a track, with its own in point, out point and position in the sequence.
_Avoid_: Element, track item, segment

### Editing

**In point / Out point**:
The first and last frame of the source that a clip plays.
_Avoid_: Trim start / trim end

**Playhead**:
The current-time position in the sequence.
_Avoid_: Cursor, current time indicator

**Marker**:
A named point or range on a sequence, used for notes and navigation.
_Avoid_: Bookmark

**Razor**:
Splitting a clip into two clips at a point in time.
_Avoid_: Split, cut (as a verb for this tool)

**Ripple delete**:
Removing a clip or gap and closing the resulting gap by shifting later clips earlier.

### Takes

**Section**:
One passage of what the creator meant to say, such as an intro or a single point.

**Take**:
One attempt by the creator at delivering a section.
_Avoid_: Attempt, try, retake (as a noun)

**Best take**:
The take of a section that the rough cut keeps.
_Avoid_: Good take, final take, keeper

**Bad take**:
Any take of a section other than its best take.
_Avoid_: Missed take, outtake

**Take removal**:
Cutting a section's bad takes out of the sequence.

**False start**:
A phrase the creator abandoned and immediately restarted within a take.
_Avoid_: Stumble, restart

**Filler word**:
A spoken word that carries no content, such as "um" or "uh".

**Pause**:
A stretch of silence within or between takes.
_Avoid_: Gap (a gap is empty space in a track), dead air, filler space

**Removal marker**:
A marker left where take removal cut a section's bad takes. It keeps those takes so they can be restored or swapped in at any time, independently of undo history.
_Avoid_: Undo marker, cut marker

**Restore**:
Putting a removal marker's takes back into the sequence as a new, undoable edit.

**Swap**:
Making one of a removal marker's stored takes the best take, in place of the one the agent kept.

### Learning

**Correction**:
A creator edit that changes something the agent cut or kept, such as a swap, a restore or re-trimming a pause. Finishing-pass additions are not corrections.

**Editing profile**:
The creator's preferences, learned from take rankings and corrections, that guide how the agent makes rough cuts.
_Avoid_: Taste, style guide, memory

**Profile agent**:
A small agent built into Splice whose only job is to analyze corrections and maintain the editing profile. It never edits the sequence.
_Avoid_: Assistant, learner

**Profile question**:
A short question the profile agent asks in the editor when it can't tell why the creator made a correction. The answer is saved to the editing profile.

### Workflow

**Format**:
Whether a project is a horizontal video (16:9, 1920×1080) or a short (9:16, 1080×1920). It is chosen when the project is created and doesn't change.

**Short**:
A vertical video made from its own vertical recordings, never cut from a horizontal video. Its rough cut always gets burned-in captions.
_Avoid_: Reel, clip (a clip is an item on a track)

**Raw sequence**:
A sequence holding every recording for a video, in recording order, as one continuous session. The agent never edits it.

**Rough Cut**:
The first assembled version of a sequence, produced by the agent from raw recordings, with bad takes, false starts and pauses removed.

**Finishing Pass**:
The creator's manual editing after the rough cut, which adds memes, graphics, text and polish.
_Avoid_: Final cut, polish pass

**Video style**:
The presentation chosen within a project's format. Horizontal projects use the YouTube style. Short projects can use Explainer or Raw.

**Gaze continuity**:
Placing the next important detail near the point the viewer was following in the preceding shot, so the viewer can follow an action across a cut.
