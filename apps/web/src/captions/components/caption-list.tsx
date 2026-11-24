"use client";

import { CAPTION_SCOPES, type CaptionScope } from "@splice/bridge/delivery";
import { Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/library/views/base-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import { isPreviewOverlayVisible } from "@/preview/overlays";
import { usePreviewStore } from "@/preview/preview-store";
import { cn } from "@/utils/ui";
import { mediaTimeToSeconds } from "@/wasm";
import { type CaptionCue, changedWords, cueAt } from "../cues";
import { captionsPreviewOverlay } from "../preview-overlay-source";
import {
	correctCaption,
	loadCaptionWords,
	playCue,
} from "../project-captions";
import { useCaptionsStore } from "../store";
import { useCaptionCues } from "../use-caption-cues";

const SCOPE_LABELS: Record<CaptionScope, string> = {
	cue: "This cue",
	project: "Everywhere in this project",
	spelling: "Always (save the spelling)",
};

const CORRECTED_LABELS: Record<CaptionScope, string> = {
	cue: "Edited",
	project: "Project fix",
	spelling: "Spelling",
};

function formatTime(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds - minutes * 60;
	return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Horizontal projects' captions: the SRT cues export writes, to play and correct. */
export function CaptionList() {
	const editor = useEditor();
	const cues = useCaptionCues();
	const hasWords = useEditor(
		(e) => !!e.project.getActiveOrNull()?.captions?.sources.length,
	);
	const selectedCueId = useCaptionsStore((state) => state.selectedCueId);
	const selectCue = useCaptionsStore((state) => state.selectCue);
	const loadSpellings = useCaptionsStore((state) => state.loadSpellings);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);
	const showInPreview = isPreviewOverlayVisible({
		overlay: captionsPreviewOverlay,
		overlays,
	});
	const playingCueId = useEditor((e) =>
		e.playback.getIsPlaying()
			? (cueAt({
					cues,
					time: mediaTimeToSeconds({ time: e.playback.getCurrentTime() }),
				})?.id ?? null)
			: null,
	);
	const [loading, setLoading] = useState(false);
	const [notice, setNotice] = useState<{
		tone: "info" | "error";
		text: string;
	} | null>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		loadSpellings().catch((error: unknown) =>
			setNotice({
				tone: "error",
				text: `Couldn't load saved spellings: ${errorMessage(error)}`,
			}),
		);
	}, [loadSpellings]);

	// A cue selected in the preview scrolls into view here.
	useEffect(() => {
		if (!selectedCueId) return;
		listRef.current
			?.querySelector(`[data-cue-id="${CSS.escape(selectedCueId)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selectedCueId]);

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
						: { tone: "info", text: `Loaded ${loaded} transcript(s).` },
			);
		} catch (error) {
			setNotice({ tone: "error", text: errorMessage(error) });
		} finally {
			setLoading(false);
		}
	};

	return (
		<PanelView title="Captions" contentClassName="flex flex-col gap-3 pb-4">
			{/* In the body, not the header, so it fits a narrow panel. */}
			<Button
				size="sm"
				variant="outline"
				className="h-auto min-h-7 w-full whitespace-normal"
				onClick={handleLoad}
				disabled={loading}
			>
				{loading && <Spinner />}
				{hasWords ? "Reload transcripts" : "Load transcripts"}
			</Button>
			<div className="flex flex-wrap items-center justify-between gap-2 px-1">
				<p className="text-muted-foreground text-xs">
					{cues.length
						? `${cues.length} cues, exported as SRT next to the MP4`
						: "Exported as SRT next to the MP4"}
				</p>
				<div className="flex items-center gap-2">
					<Switch
						id="captions-in-preview"
						checked={showInPreview}
						onCheckedChange={(checked) =>
							setOverlayVisibility({
								overlayId: captionsPreviewOverlay.id,
								isVisible: checked,
							})
						}
					/>
					<Label htmlFor="captions-in-preview" className="text-xs">
						Show in preview
					</Label>
				</div>
			</div>
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
				<p className="text-muted-foreground px-1 text-sm">
					No caption words yet. Transcribe the recordings, then load their
					transcripts.
				</p>
			) : cues.length === 0 ? (
				<p className="text-muted-foreground px-1 text-sm">
					No narration is heard on this sequence.
				</p>
			) : (
				<div ref={listRef} className="flex flex-col gap-1" role="list">
					{cues.map((cue) => (
						<CueRow
							key={cue.id}
							cue={cue}
							isSelected={cue.id === selectedCueId}
							isPlaying={cue.id === playingCueId}
							onSelect={() =>
								selectCue(cue.id === selectedCueId ? null : cue.id)
							}
							onClose={() => selectCue(null)}
						/>
					))}
				</div>
			)}
			<SavedSpellings />
		</PanelView>
	);
}

function CueRow({
	cue,
	isSelected,
	isPlaying,
	onSelect,
	onClose,
}: {
	cue: CaptionCue;
	isSelected: boolean;
	isPlaying: boolean;
	onSelect: () => void;
	onClose: () => void;
}) {
	const editor = useEditor();
	return (
		<div
			role="listitem"
			data-cue-id={cue.id}
			className={cn(
				"rounded-md border border-transparent",
				isSelected && "border-border bg-accent/40",
				isPlaying && !isSelected && "bg-accent/60",
			)}
		>
			<div className="flex items-start gap-1 p-1">
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0"
					aria-label={
						isPlaying ? `Pause cue ${cue.index}` : `Play cue ${cue.index}`
					}
					onClick={() =>
						isPlaying ? editor.playback.pause() : playCue({ editor, cue })
					}
				>
					{isPlaying ? <Pause /> : <Play />}
				</Button>
				<button
					type="button"
					onClick={onSelect}
					aria-expanded={isSelected}
					aria-label={`Cue ${cue.index}, ${formatTime(cue.start)}: ${cue.text || "hidden"}. ${isSelected ? "Close" : "Correct"}.`}
					className="min-w-0 flex-1 cursor-pointer rounded-sm px-1 py-0.5 text-left"
				>
					<span className="text-muted-foreground flex items-center gap-2 text-[0.7rem] tabular-nums">
						{formatTime(cue.start)} – {formatTime(cue.end)}
						{cue.correctedBy && (
							<Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
								{CORRECTED_LABELS[cue.correctedBy]}
							</Badge>
						)}
					</span>
					<span
						className={cn(
							"block text-sm break-words",
							!cue.text && "text-muted-foreground italic",
						)}
					>
						{cue.text || `Hidden: ${cue.originalText ?? ""}`}
					</span>
				</button>
			</div>
			{isSelected && <CueEditor cue={cue} onClose={onClose} />}
		</div>
	);
}

function CueEditor({ cue, onClose }: { cue: CaptionCue; onClose: () => void }) {
	const editor = useEditor();
	const [text, setText] = useState(cue.text);
	const [scope, setScope] = useState<CaptionScope>("cue");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const replacement =
		scope === "cue" ? null : changedWords({ before: cue.text, after: text });
	const unchanged = text.replace(/\s+/g, " ").trim() === cue.text;
	const textRef = useRef<HTMLTextAreaElement>(null);
	// Opening a cue to correct it puts the cursor in its text.
	useEffect(() => {
		textRef.current?.focus({ preventScroll: true });
	}, []);

	const handleSave = async () => {
		setSaving(true);
		setError(null);
		try {
			await correctCaption({ editor, cue, text, scope });
			onClose();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="flex flex-col gap-2 border-t p-2"
			onSubmit={(event) => {
				event.preventDefault();
				void handleSave();
			}}
		>
			<Label htmlFor={`cue-text-${cue.id}`} className="text-xs">
				Caption text
			</Label>
			<Textarea
				id={`cue-text-${cue.id}`}
				value={text}
				rows={2}
				ref={textRef}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						void handleSave();
					}
					if (event.key === "Escape") onClose();
				}}
			/>
			{cue.originalText && (
				<p className="text-muted-foreground text-xs">
					Transcript: {cue.originalText}
				</p>
			)}
			<RadioGroup
				value={scope}
				onValueChange={(value) => {
					const chosen = CAPTION_SCOPES.find((scope) => scope === value);
					if (chosen) setScope(chosen);
				}}
				aria-label="Apply the correction to"
				className="gap-1.5"
			>
				{CAPTION_SCOPES.map((value) => (
					<div key={value} className="flex items-center gap-2">
						<RadioGroupItem value={value} id={`cue-scope-${cue.id}-${value}`} />
						<Label
							htmlFor={`cue-scope-${cue.id}-${value}`}
							className="text-xs font-normal"
						>
							{SCOPE_LABELS[value]}
						</Label>
					</div>
				))}
			</RadioGroup>
			{scope !== "cue" && (
				<p className="text-muted-foreground text-xs" aria-live="polite">
					{replacement
						? `Replaces “${replacement.from}” with “${replacement.to}”${scope === "spelling" ? " in every project" : " wherever it is heard"}.`
						: "Change at least one word to correct it everywhere."}
				</p>
			)}
			{error && (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onClose}>
					Cancel
				</Button>
				<Button
					type="submit"
					size="sm"
					disabled={
						saving || (scope === "cue" ? unchanged : replacement === null)
					}
				>
					{saving && <Spinner />}
					Save correction
				</Button>
			</div>
		</form>
	);
}

function SavedSpellings() {
	const spellings = useCaptionsStore((state) => state.spellings);
	const removeSpelling = useCaptionsStore((state) => state.removeSpelling);
	const [error, setError] = useState<string | null>(null);
	if (!spellings.length) return null;
	return (
		<section className="flex flex-col gap-1.5 border-t px-1 pt-3">
			<h3 className="text-muted-foreground text-xs font-medium">
				Saved spellings (every project)
			</h3>
			<ul className="flex flex-col gap-1">
				{spellings.map((spelling) => (
					<li
						key={spelling.from}
						className="flex items-center justify-between gap-2 text-xs"
					>
						<span className="min-w-0 break-words">
							{spelling.from} → <strong>{spelling.to}</strong>
						</span>
						<Button
							variant="ghost"
							size="icon"
							aria-label={`Remove the spelling ${spelling.to}`}
							onClick={() =>
								removeSpelling(spelling.from).catch((failure: unknown) =>
									setError(errorMessage(failure)),
								)
							}
						>
							<X />
						</Button>
					</li>
				))}
			</ul>
			{error && (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			)}
		</section>
	);
}
