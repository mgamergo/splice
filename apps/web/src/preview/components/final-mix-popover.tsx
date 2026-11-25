"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { UpdateMusicRequest } from "@splice/bridge/mix";
import { callSplice } from "@/bridge/splice-api";
import { readBridgeToken } from "@/bridge/token";
import { importDiskItems } from "@/media/import-disk";
import { isDiskMedia } from "@/media/media-data";
import { EditorApi } from "@/agent/editor-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useEditor } from "@/editor/use-editor";
import { isMixLoudnessStale } from "@/mix/final-mix";
import { contentEndSeconds } from "@/mix/music";
import { pictureRepairs } from "@/mix/picture-repair";
import { mediaTimeToSeconds } from "@/wasm";

export function FinalMixPopover() {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="text" size="sm">
					Final mix
				</Button>
			</PopoverTrigger>
			<PopoverContent
				aria-label="Final mix"
				align="end"
				className="w-[min(24rem,90vw)] max-h-[min(75vh,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain p-4"
			>
				<FinalMixControls />
			</PopoverContent>
		</Popover>
	);
}

const footageFilesSchema = z.array(
	z.object({ path: z.string(), contentType: z.string() }),
);
const FOOTAGE_PREFIX = "footage:";

function FinalMixControls() {
	const editor = useEditor();
	const api = useMemo(() => new EditorApi(editor), [editor]);
	const sequence = useEditor((e) => e.sequences.getActiveSequence());
	const items = useEditor((e) => e.media.getProjectItems());
	const [busy, setBusy] = useState<string | null>(null);
	const [footageAudio, setFootageAudio] = useState<string[]>([]);
	const [footageError, setFootageError] = useState<string | null>(null);
	useEffect(() => {
		if (!readBridgeToken()) return;
		let active = true;
		void callSplice({ method: "footage.list" })
			.then((result) => {
				if (active)
					setFootageAudio(
						footageFilesSchema
							.parse(result)
							.filter(({ contentType }) => contentType.startsWith("audio/"))
							.map(({ path }) => path),
					);
			})
			.catch(() => {
				if (active)
					setFootageError(
						"Couldn't list Footage. Project items are still available.",
					);
			});
		return () => {
			active = false;
		};
	}, []);
	const music = sequence.mix?.music;
	const loudness = sequence.mix?.loudness;
	const audioItems = items.filter(
		(item) => item.type === "audio" && !item.missing,
	);
	const importedPaths = new Set(
		audioItems.flatMap(({ file }) => (isDiskMedia(file) ? [file.path] : [])),
	);
	const repairs = pictureRepairs({ tracks: sequence.tracks });
	const maxTime = contentEndSeconds({ tracks: sequence.tracks, music });
	const playhead = () =>
		mediaTimeToSeconds({ time: editor.playback.getCurrentTime() });
	const request = () => ({
		sequenceId: sequence.id,
		expectedRevision: api.getRevision(),
	});

	const adjustMusic = (
		options: Omit<UpdateMusicRequest, "sequenceId" | "expectedRevision">,
	) => api.updateMusic({ request: { ...request(), ...options } });

	async function run({
		label,
		action,
		success,
	}: {
		label: string;
		action: () => Promise<EditResult> | EditResult;
		success?: string;
	}) {
		setBusy(label);
		try {
			const result = await action();
			if (!result.ok) toast.error(result.message);
			else if (success) toast.success(success);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Couldn't update the mix.",
			);
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="space-y-4 text-sm" aria-busy={!!busy}>
			{busy && (
				<p role="status" className="text-muted-foreground">
					{busy}
				</p>
			)}
			<section className="space-y-2" aria-label="Whole-mix loudness">
				<h3 className="font-medium">Whole-mix loudness</h3>
				{loudness && (
					<p className="text-muted-foreground">
						{loudness.expectedLufs} LUFS · {loudness.expectedTruePeakDbtp} dBTP
						{isMixLoudnessStale({ sequence, projectItems: items }) &&
							" · Mix changed. Measure again."}
					</p>
				)}
				<Button
					size="sm"
					disabled={!!busy || maxTime <= 0}
					onClick={() =>
						void run({
							label: "Measuring the mix…",
							action: () =>
								api.mixLoudness({
									request: { ...request(), label: "Set mix loudness" },
								}),
							success: "Final mix ready for playback and export.",
						})
					}
				>
					{loudness ? "Measure and adjust again" : "Adjust to −14 LUFS"}
				</Button>
			</section>

			<section className="space-y-2 border-t pt-3" aria-label="Music">
				<h3 className="font-medium">Music</h3>
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						const fields = new FormData(event.currentTarget);
						const selection = fields.get("music");
						if (typeof selection !== "string") return;
						const revision = request();
						void run({
							label: "Fitting music…",
							action: async () => {
								let projectItemId = selection;
								if (selection.startsWith(FOOTAGE_PREFIX)) {
									const path = selection.slice(FOOTAGE_PREFIX.length);
									const result = await importDiskItems({
										editor,
										paths: [path],
										isBlocked: () => false,
									});
									const item = result.imported[0];
									if (!item)
										throw new Error(
											result.failed[0]?.error ??
												"Couldn't import the track from Footage.",
										);
									projectItemId = item.id;
								}
								return api.addMusic({
									request: {
										...revision,
										projectItemId,
										label: "Add music",
									},
								});
							},
						});
					}}
				>
					<ItemSelect
						label="Music track"
						name="music"
						items={audioItems}
						footage={footageAudio.filter((path) => !importedPaths.has(path))}
						selected={music?.projectItemId}
						key={music?.projectItemId}
					/>
					{footageError && (
						<p role="status" className="text-muted-foreground">
							{footageError}
						</p>
					)}
					<div className="flex gap-2">
						<Button
							type="submit"
							size="sm"
							variant="outline"
							disabled={!!busy || maxTime <= 0}
						>
							{music ? "Replace music" : "Fit music"}
						</Button>
						{music && (
							<Button
								type="button"
								size="sm"
								variant="text"
								disabled={!!busy}
								onClick={() =>
									void run({
										label: "Removing music…",
										action: () =>
											api.removeMusic({ ...request(), label: "Remove music" }),
									})
								}
							>
								Remove music
							</Button>
						)}
					</div>
				</form>
				{music && (
					<>
						<form
							key={JSON.stringify([sequence.id, music])}
							className="space-y-2"
							onSubmit={(event) => {
								event.preventDefault();
								const fields = new FormData(event.currentTarget);
								void run({
									label: "Refitting music…",
									action: () =>
										adjustMusic({
											label: "Adjust music",
											levelDb: numberField({ fields, name: "level" }),
											duckDb: -numberField({ fields, name: "duck" }),
											fadeInSeconds: numberField({ fields, name: "fadeIn" }),
											fadeOutSeconds: numberField({ fields, name: "fadeOut" }),
										}),
								});
							}}
						>
							<div className="grid grid-cols-2 gap-2">
								<NumberField
									label="Quiet level (dB)"
									name="level"
									value={music.levelDb}
									min={-60}
									max={20}
								/>
								<NumberField
									label="Ducking depth (dB)"
									name="duck"
									value={-music.duckDb}
									max={60}
								/>
								<NumberField
									label="Fade in (s)"
									name="fadeIn"
									value={music.fadeInSeconds}
									max={30}
								/>
								<NumberField
									label="Fade out (s)"
									name="fadeOut"
									value={music.fadeOutSeconds}
									max={30}
								/>
							</div>
							<Button
								type="submit"
								size="sm"
								variant="outline"
								disabled={!!busy}
							>
								Refit and redraw keyframes
							</Button>
						</form>
						<h4 className="font-medium">Application sound passages</h4>
						<form
							className="space-y-2"
							onSubmit={(event) => {
								event.preventDefault();
								const fields = new FormData(event.currentTarget);
								void run({
									label: "Ducking music…",
									action: () =>
										adjustMusic({
											label: "Duck music for application sound",
											overrides: [
												...music.overrides,
												{
													start: numberField({ fields, name: "start" }),
													end: numberField({ fields, name: "end" }),
												},
											],
										}),
								});
							}}
						>
							<div className="grid grid-cols-2 gap-2">
								<NumberField
									label="Start (sequence s)"
									name="start"
									value={playhead()}
									max={maxTime}
								/>
								<NumberField
									label="End (sequence s)"
									name="end"
									max={maxTime}
								/>
							</div>
							<Button
								type="submit"
								size="sm"
								variant="outline"
								disabled={!!busy}
							>
								Keep music ducked
							</Button>
						</form>
						{music.overrides.map(({ start, end }, index) => (
							<div key={index} className="flex items-center justify-between">
								<span>
									{start}–{end} s
								</span>
								<Button
									size="sm"
									variant="text"
									disabled={!!busy}
									aria-label={`Remove ducking at ${start}–${end} seconds`}
									onClick={() =>
										void run({
											label: "Updating ducking…",
											action: () =>
												adjustMusic({
													label: "Remove application sound passage",
													overrides: music.overrides.filter(
														(_, candidate) => candidate !== index,
													),
												}),
										})
									}
								>
									Remove
								</Button>
							</div>
						))}
					</>
				)}
			</section>

			<section className="space-y-2 border-t pt-3" aria-label="Picture repair">
				<h3 className="font-medium">Picture repair</h3>
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						const fields = new FormData(event.currentTarget);
						void run({
							label: "Adding picture repair…",
							action: () =>
								api.apply({
									...request(),
									label: "Add picture repair",
									ops: [
										{
											op: "picture_repair",
											at: { seconds: numberField({ fields, name: "at" }) },
											duration: {
												seconds: numberField({ fields, name: "duration" }),
											},
											sourceIn: numberField({ fields, name: "sourceIn" }),
											projectItemId: fields.get("take"),
										},
									],
								}),
						});
					}}
				>
					<ItemSelect
						label="Replacement take"
						name="take"
						items={items.filter(
							(item) => item.type === "video" && !item.missing,
						)}
					/>
					<div className="grid grid-cols-3 gap-2">
						<NumberField
							label="Sequence in (s)"
							name="at"
							value={playhead()}
							max={maxTime}
						/>
						<NumberField label="Source in (s)" name="sourceIn" value={0} />
						<NumberField
							label="Duration (s)"
							name="duration"
							min={0.001}
							max={maxTime}
						/>
					</div>
					<Button
						type="submit"
						size="sm"
						variant="outline"
						disabled={!!busy || maxTime <= 0}
					>
						Replace picture only
					</Button>
				</form>
				{repairs.length > 0 && (
					<form
						className="space-y-2"
						onSubmit={(event) => {
							event.preventDefault();
							const fields = new FormData(event.currentTarget);
							void run({
								label: "Adding repair sound…",
								action: () =>
									api.apply({
										...request(),
										label: "Bring in repair sound",
										ops: [
											{
												op: "repair_sound",
												clipId: fields.get("repair"),
												start: {
													seconds: numberField({ fields, name: "start" }),
												},
												end: { seconds: numberField({ fields, name: "end" }) },
											},
										],
									}),
							});
						}}
					>
						<ItemSelect
							label="Picture repair to bring sound from"
							name="repair"
							items={repairs.map(({ clip }) => ({
								id: clip.id,
								name: `${clip.name} at ${mediaTimeToSeconds({ time: clip.startTime }).toFixed(2)} s`,
							}))}
						/>
						<div className="grid grid-cols-2 gap-2">
							<NumberField label="Sound start (sequence s)" name="start" />
							<NumberField label="Sound end (sequence s)" name="end" />
						</div>
						<Button type="submit" size="sm" variant="outline" disabled={!!busy}>
							Bring in repair sound
						</Button>
					</form>
				)}
			</section>
		</div>
	);
}

type EditResult = { ok: true } | { ok: false; message: string };

function Field({
	id,
	label,
	children,
}: {
	id: string;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1 text-xs">
			<label htmlFor={id}>{label}</label>
			{children}
		</div>
	);
}

function ItemSelect({
	label,
	name,
	items,
	selected,
	footage = [],
}: {
	label: string;
	name: string;
	items: { id: string; name: string }[];
	selected?: string;
	footage?: string[];
}) {
	const id = useId();
	return (
		<Field id={id} label={label}>
			<select
				id={id}
				name={name}
				defaultValue={selected ?? ""}
				required
				className="border-border bg-input text-foreground w-full rounded-md border px-2 py-1.5 text-sm"
			>
				<option value="" disabled>
					Choose an item
				</option>
				{items.map((item) => (
					<option key={item.id} value={item.id}>
						{item.name}
					</option>
				))}
				{footage.length > 0 && (
					<optgroup label="Footage">
						{footage.map((path) => (
							<option key={path} value={FOOTAGE_PREFIX + path}>
								{path}
							</option>
						))}
					</optgroup>
				)}
			</select>
		</Field>
	);
}

function NumberField({
	label,
	name,
	value,
	min = 0,
	max,
}: {
	label: string;
	name: string;
	value?: number;
	min?: number;
	max?: number;
}) {
	const id = useId();
	return (
		<Field id={id} label={label}>
			<Input
				id={id}
				name={name}
				size="sm"
				type="number"
				step="any"
				min={min}
				max={max}
				defaultValue={value}
				required
			/>
		</Field>
	);
}

function numberField({ fields, name }: { fields: FormData; name: string }) {
	return Number(fields.get(name));
}
