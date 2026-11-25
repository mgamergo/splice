import {
	applyStyleUpdateSchema,
	type StyleDefaults,
} from "@splice/bridge/style";
import { restyleCaptions } from "@/agent/captions";
import { syncGraphics } from "@/agent/graphics";
import { CAPTION_TRACK_NAME } from "@/agent/short-captions";
import { layoutShort } from "@/agent/short-layout";
import {
	fetchStyleDefaults,
	projectStyle,
	sequenceStyle,
} from "@/agent/style-profile";
import { BatchCommand } from "@/commands/batch-command";
import { UpdateProjectSettingsCommand } from "@/commands/project/update-project-settings";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import type { EditorCore } from "@/core";
import type { ProjectItem } from "@/media/types";
import { projectShortStyle } from "@/project/format";
import type { TProject } from "@/project/types";
import type { SequenceTracks, TimelineClip, TSequence } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import { mediaTimeToSeconds, roundMediaTime } from "@/wasm";

interface StyleChange {
	id: string;
	kind: "zoom" | "highlight" | "card" | "caption";
	clip: string;
	time: number;
	properties: string[];
}

const isHidden = (clip: TimelineClip) => "hidden" in clip && !!clip.hidden;

function clipMap(tracks: SequenceTracks) {
	const map = new Map<string, TimelineClip>();
	for (const track of tracks.overlay)
		for (const clip of track.clips)
			if (clip.graphicId || track.name === CAPTION_TRACK_NAME)
				map.set(clip.id, clip);
	return map;
}

function changesFor({
	before,
	after,
	oldStyle,
	newStyle,
}: {
	before: TSequence;
	after: TSequence;
	oldStyle: StyleDefaults;
	newStyle: StyleDefaults;
}): StyleChange[] {
	const original = clipMap(before.tracks);
	const updated = clipMap(after.tracks);
	const graphics = new Map(
		after.graphics?.records.map((record) => [record.id, record]),
	);
	const ids = new Set([...original.keys(), ...updated.keys()]);
	return [...ids].flatMap((id) => {
		const oldClip = original.get(id);
		const newClip = updated.get(id);
		const clip = newClip ?? oldClip;
		if (!clip) return [];
		const record = clip.graphicId ? graphics.get(clip.graphicId) : undefined;
		const kind = record?.kind ?? "caption";
		if (oldClip && newClip && isHidden(oldClip) && isHidden(newClip)) return [];
		const properties: string[] = [];
		if (!oldClip || !newClip) {
			properties.push(newClip ? "shown" : "off the sequence");
		} else {
			const keys = new Set([
				...Object.keys(oldClip.params),
				...Object.keys(newClip.params),
			]);
			for (const key of keys)
				if (oldClip.params[key] !== newClip.params[key]) properties.push(key);
			if (
				oldClip.startTime !== newClip.startTime ||
				oldClip.duration !== newClip.duration
			)
				properties.push("timing");
			if (isHidden(oldClip) !== isHidden(newClip))
				properties.push("visibility");
			if (
				kind === "zoom" &&
				newClip.graphicId &&
				[after.tracks.main, ...after.tracks.overlay].some((track) =>
					track.clips.some(
						(picture) =>
							picture.type === "video" &&
							picture.zoomGraphicIds?.includes(newClip.graphicId ?? ""),
					),
				)
			) {
				if (oldStyle.values.zoom.easing !== newStyle.values.zoom.easing)
					properties.push("easing");
				if (
					oldStyle.values.zoom.rampSeconds !==
						newStyle.values.zoom.rampSeconds &&
					Math.min(
						oldStyle.values.zoom.rampSeconds,
						mediaTimeToSeconds({ time: clip.duration }) / 3,
					) !==
						Math.min(
							newStyle.values.zoom.rampSeconds,
							mediaTimeToSeconds({ time: clip.duration }) / 3,
						)
				)
					properties.push("ramp duration");
			}
		}
		if (!properties.length) return [];
		return [
			{
				id,
				kind,
				clip: record?.key ?? clip.name,
				time:
					properties.includes("easing") || properties.includes("ramp duration")
						? mediaTimeToSeconds({ time: clip.startTime }) +
							Math.min(
								oldStyle.values.zoom.rampSeconds,
								newStyle.values.zoom.rampSeconds,
								mediaTimeToSeconds({ time: clip.duration }) / 3,
							) /
								4
						: mediaTimeToSeconds({
								time: roundMediaTime({
									time: clip.startTime + clip.duration / 2,
								}),
							}),
				properties,
			},
		];
	});
}

export function planStyleUpdate({
	project,
	sequences,
	projectItems,
	defaults,
}: {
	project: TProject;
	sequences: TSequence[];
	projectItems: ProjectItem[];
	defaults: StyleDefaults;
}) {
	const shortStyle = projectShortStyle({ project });
	const canvas = project.settings.canvasSize;
	return sequences.map((before) => {
		const oldStyle = sequenceStyle({ project, sequence: before });
		const graphics = syncGraphics({
			sequence: before,
			projectItems,
			canvas,
			shortStyle,
			style: defaults.values,
			previousStyle: oldStyle.values,
		});
		let after = {
			...before,
			...graphics,
			styleDefaults: undefined,
		} satisfies TSequence;
		if (shortStyle) {
			if (after.captions)
				after = {
					...after,
					...restyleCaptions({
						tracks: after.tracks,
						captions: after.captions,
						defaults: defaults.values,
						canvas,
					}),
				};
			after = {
				...after,
				tracks: layoutShort({
					sequence: after,
					style: shortStyle,
					canvas,
					projectItems,
					defaults: defaults.values,
				}),
			};
		}
		return {
			before,
			after,
			changes: changesFor({ before, after, oldStyle, newStyle: defaults }),
		};
	});
}

export interface StylePreview {
	id: string;
	revision: number;
	projectId: string;
	sequenceId: string;
	mediaGeneration: number;
	from: number;
	defaults: StyleDefaults;
	sequences: ReturnType<typeof planStyleUpdate>;
}

export class StyleUpdateApi {
	private latest?: StylePreview;

	private readonly editor: EditorCore;
	private readonly readDefaults: typeof fetchStyleDefaults;

	constructor({
		editor,
		readDefaults = fetchStyleDefaults,
	}: {
		editor: EditorCore;
		readDefaults?: typeof fetchStyleDefaults;
	}) {
		this.editor = editor;
		this.readDefaults = readDefaults;
	}

	async preview() {
		const defaults = await this.readDefaults();
		const project = this.editor.project.getActive();
		if (this.editor.timeline.isPreviewActive())
			throw new Error(
				"Finish the current edit before previewing a style update.",
			);
		const from = projectStyle(project).revision;
		if (defaults.revision <= from) return null;
		const preview: StylePreview = {
			id: generateUUID(),
			revision: this.editor.command.getRevision(),
			projectId: project.metadata.id,
			sequenceId: this.editor.sequences.getActiveSequence().id,
			mediaGeneration: this.editor.media.getGeneration(),
			from,
			defaults,
			sequences: planStyleUpdate({
				project,
				sequences: this.editor.sequences.getSequences(),
				projectItems: this.editor.media.getProjectItems(),
				defaults,
			}),
		};
		this.latest = preview;
		return preview;
	}

	async apply({
		request,
		beforeWrite,
	}: {
		request: unknown;
		beforeWrite?: () => void;
	}) {
		const parsed = applyStyleUpdateSchema.safeParse(request);
		if (!parsed.success)
			return {
				ok: false as const,
				code: "INVALID_REQUEST",
				message: parsed.error.message,
			};
		const defaults = await this.readDefaults();
		beforeWrite?.();
		const preview = this.latest;
		const revision = this.editor.command.getRevision();
		const project = this.editor.project.getActiveOrNull();
		if (
			!preview ||
			preview.id !== parsed.data.previewId ||
			preview.revision !== revision ||
			parsed.data.expectedRevision !== revision ||
			preview.projectId !== project?.metadata.id ||
			preview.sequenceId !==
				this.editor.sequences.getActiveSequenceOrNull()?.id ||
			preview.mediaGeneration !== this.editor.media.getGeneration() ||
			this.editor.timeline.isPreviewActive() ||
			JSON.stringify(defaults) !== JSON.stringify(preview.defaults)
		)
			return {
				ok: false as const,
				code: "REVISION_CONFLICT",
				revision,
				message:
					"The project or defaults changed. Preview the style update again.",
			};

		this.editor.command.execute({
			command: new UpdateStyleCommand([
				new UpdateProjectSettingsCommand({ styleDefaults: defaults }),
				...preview.sequences
					.filter(
						({ before, after }) =>
							before.tracks !== after.tracks ||
							before.captions !== after.captions ||
							before.graphics !== after.graphics ||
							before.styleDefaults !== after.styleDefaults,
					)
					.map(
						({ after }) =>
							new UpdateSequenceCommand({
								editor: this.editor,
								sequenceId: after.id,
								updates: {
									tracks: after.tracks,
									graphics: after.graphics,
									captions: after.captions,
									styleDefaults: after.styleDefaults,
								},
								label: "Update style",
								keepSelection: true,
							}),
					),
			]),
		});
		this.latest = undefined;
		return {
			ok: true as const,
			revision: this.editor.command.getRevision(),
			styleRevision: defaults.revision,
		};
	}
}

class UpdateStyleCommand extends BatchCommand {
	readonly ignoresRippleToggle = true;
	readonly label = "Update style";
}

export function summarizeStylePreview(preview: StylePreview | null) {
	return preview
		? {
				ok: true as const,
				available: true as const,
				previewId: preview.id,
				revision: preview.revision,
				from: preview.from,
				to: preview.defaults,
				sequences: preview.sequences.map(({ before, changes }) => ({
					id: before.id,
					name: before.name,
					changes,
				})),
			}
		: { ok: true as const, available: false as const };
}
