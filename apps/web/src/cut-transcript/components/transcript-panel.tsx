"use client";

import { Play, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/library/views/base-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { loadCaptionWords, playCue } from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import { useEditor } from "@/editor/use-editor";
import { projectFormat } from "@/project/format";
import { cn } from "@/utils/ui";
import { mediaTimeToSeconds } from "@/wasm";
import { hasTranscriptWords } from "../sequence-transcript";
import { useTranscriptStore } from "../store";
import {
	selectedSentences,
	sentenceAt,
	type TranscriptSentence,
} from "../transcript";
import { useCutTranscript } from "../use-cut-transcript";

function formatTime(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds - minutes * 60;
	return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The sentence under the playhead, following playback frame by frame. */
function usePlayheadSentenceId(sentences: TranscriptSentence[]): string | null {
	const editor = useEditor();
	const [id, setId] = useState<string | null>(null);
	useEffect(() => {
		const update = () =>
			setId(
				sentenceAt({
					sentences,
					time: mediaTimeToSeconds({ time: editor.playback.getCurrentTime() }),
				})?.id ?? null,
			);
		update();
		const unsubscribers = [
			editor.playback.onUpdate(update),
			editor.playback.onSeek(update),
			editor.playback.subscribe(update),
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [editor, sentences]);
	return id;
}

/**
 * The cut transcript: what the sequence says, sentence by sentence. Clicking
 * a sentence plays it; shift-clicking selects a passage for the editing
 * agent, which reads it with transcript_selection.
 */
export function TranscriptPanel() {
	const editor = useEditor();
	const { paragraphs, sentences } = useCutTranscript();
	const sequence = useEditor((e) => e.sequences.getActiveSequenceOrNull());
	const project = useEditor((e) => e.project.getActiveOrNull());
	const isHorizontal = !!project && projectFormat({ project }) === "horizontal";
	const hasWords =
		!!project && !!sequence && hasTranscriptWords({ project, sequence });
	const selection = useTranscriptStore((state) => state.selection);
	const select = useTranscriptStore((state) => state.select);
	const clear = useTranscriptStore((state) => state.clear);
	const loadSpellings = useCaptionsStore((state) => state.loadSpellings);
	const playheadId = usePlayheadSentenceId(sentences);
	const [loading, setLoading] = useState(false);
	const [notice, setNotice] = useState<{
		tone: "info" | "error";
		text: string;
	} | null>(null);
	const textRef = useRef<HTMLDivElement>(null);

	const selectionOnSequence =
		selection && selection.sequenceId === sequence?.id ? selection : null;
	const selected = selectionOnSequence
		? selectedSentences({ sentences, ...selectionOnSequence })
		: null;
	const selectedIds = new Set(selected?.map(({ id }) => id));
	const selectedStart = selected?.[0]?.start ?? 0;
	const selectedEnd = Math.max(0, ...(selected ?? []).map(({ end }) => end));

	useEffect(() => {
		loadSpellings().catch((error: unknown) =>
			setNotice({
				tone: "error",
				text: `Couldn't load saved spellings: ${errorMessage(error)}`,
			}),
		);
	}, [loadSpellings]);

	// The transcript follows playback.
	useEffect(() => {
		if (!playheadId || !editor.playback.getIsPlaying()) return;
		textRef.current
			?.querySelector(`[data-sentence-id="${CSS.escape(playheadId)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [playheadId, editor]);

	const handleLoad = async () => {
		setLoading(true);
		setNotice(null);
		try {
			const { loaded, withoutTranscript } = await loadCaptionWords({ editor });
			setNotice(
				loaded === 0
					? {
							tone: "error",
							text: "No recording in this project has a transcript yet. Ask the agent to transcribe them first.",
						}
					: withoutTranscript.length
						? {
								tone: "info",
								text: `Loaded ${loaded} transcript(s). Not transcribed yet: ${withoutTranscript.join(", ")}.`,
							}
						: null,
			);
		} catch (error) {
			setNotice({ tone: "error", text: errorMessage(error) });
		} finally {
			setLoading(false);
		}
	};

	const handleSentence = ({
		sentence,
		extend,
	}: {
		sentence: TranscriptSentence;
		extend: boolean;
	}) => {
		if (!sequence) return;
		select({ sequenceId: sequence.id, sentenceId: sentence.id, extend });
		if (!extend) playCue({ editor, cue: sentence });
	};

	return (
		<PanelView title="Transcript" contentClassName="flex flex-col gap-3 pb-4">
			{notice && (
				<p
					role={notice.tone === "error" ? "alert" : "status"}
					className={cn(
						"px-1 text-xs",
						notice.tone === "error" ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{notice.text}
				</p>
			)}
			{!hasWords ? (
				<div className="flex flex-col gap-2 px-1">
					<p className="text-muted-foreground text-sm">
						{isHorizontal
							? "No transcript words yet. Transcribe the recordings, then load their transcripts."
							: "No transcript words yet. The agent loads them when it captions the rough cut."}
					</p>
					{isHorizontal && (
						<Button
							size="sm"
							variant="outline"
							className="h-auto min-h-7 w-full whitespace-normal"
							onClick={handleLoad}
							disabled={loading}
						>
							{loading && <Spinner />}
							Load transcripts
						</Button>
					)}
				</div>
			) : sentences.length === 0 ? (
				<p className="text-muted-foreground px-1 text-sm">
					No narration is heard on this sequence.
				</p>
			) : (
				<>
					<SelectionBar
						count={selected?.length ?? 0}
						isStale={!!selectionOnSequence && !selected}
						start={selectedStart}
						end={selectedEnd}
						onPlay={() =>
							playCue({ editor, cue: { start: selectedStart, end: selectedEnd } })
						}
						onClear={clear}
					/>
					<div
						ref={textRef}
						className="flex flex-col gap-3 px-1 text-sm leading-relaxed"
					>
						{paragraphs.map((paragraph, index) => {
							const section = paragraph.section;
							const showSection =
								section &&
								section.markerId !== paragraphs[index - 1]?.section?.markerId;
							return (
								<Fragment key={paragraph.id}>
									{showSection && (
										<h3 className="text-muted-foreground -mb-2 text-xs font-medium">
											{section.name}
										</h3>
									)}
									<p>
										{paragraph.sentences.map((sentence) => (
											<Fragment key={sentence.id}>
												<SentenceButton
													sentence={sentence}
													isCurrent={sentence.id === playheadId}
													isSelected={selectedIds.has(sentence.id)}
													onClick={(extend) =>
														handleSentence({ sentence, extend })
													}
												/>{" "}
											</Fragment>
										))}
									</p>
								</Fragment>
							);
						})}
					</div>
				</>
			)}
		</PanelView>
	);
}

function SentenceButton({
	sentence,
	isCurrent,
	isSelected,
	onClick,
}: {
	sentence: TranscriptSentence;
	isCurrent: boolean;
	isSelected: boolean;
	onClick: (extend: boolean) => void;
}) {
	return (
		<button
			type="button"
			data-sentence-id={sentence.id}
			aria-pressed={isSelected}
			aria-current={isCurrent ? "time" : undefined}
			title={`${formatTime(sentence.start)} – ${formatTime(sentence.end)}`}
			onClick={(event) => onClick(event.shiftKey)}
			className={cn(
				"hover:bg-accent/60 inline cursor-pointer rounded-sm px-0.5 text-left [box-decoration-break:clone]",
				isCurrent && "bg-accent text-accent-foreground",
				isSelected && "bg-primary/20 ring-primary/40 ring-1",
			)}
		>
			{sentence.text}
		</button>
	);
}

function SelectionBar({
	count,
	isStale,
	start,
	end,
	onPlay,
	onClear,
}: {
	count: number;
	isStale: boolean;
	start: number;
	end: number;
	onPlay: () => void;
	onClear: () => void;
}) {
	if (isStale)
		return (
			<div className="bg-muted/50 flex items-center gap-2 rounded-md p-2 text-xs">
				<p role="status" className="text-muted-foreground flex-1">
					An edit changed the selected passage. Select it again.
				</p>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Clear the selection"
					onClick={onClear}
				>
					<X />
				</Button>
			</div>
		);
	if (!count)
		return (
			<p className="text-muted-foreground px-1 text-xs">
				Click a sentence to play and select it. Shift-click another to
				select a passage for the agent in T3 Code.
			</p>
		);
	return (
		<div className="bg-muted/50 sticky top-0 z-10 flex items-center gap-1 rounded-md p-1 pl-2 text-xs">
			<p role="status" className="min-w-0 flex-1">
				<span className="font-medium">
					{count === 1 ? "1 sentence" : `${count} sentences`}
				</span>{" "}
				<span className="text-muted-foreground tabular-nums">
					{formatTime(start)} – {formatTime(end)}
				</span>
				<span className="text-muted-foreground block">
					The agent in T3 Code can read this selection.
				</span>
			</p>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Play the selection"
				onClick={onPlay}
			>
				<Play />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Clear the selection"
				onClick={onClear}
			>
				<X />
			</Button>
		</div>
	);
}
