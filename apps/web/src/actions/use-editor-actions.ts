"use client";

import { useEffect, useState } from "react";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useActionHandler } from "@/actions/use-action-handler";
import { useEditor } from "@/editor/use-editor";
import { useClipSelection } from "@/timeline/hooks/clip/use-clip-selection";
import {
	addMediaTime,
	maxMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	minMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { useKeyframeSelection } from "@/timeline/hooks/clip/use-keyframe-selection";
import { getClipsAtTime, hasMediaId } from "@/timeline";
import { cancelInteraction } from "@/editor/cancel-interaction";
import { invokeAction } from "@/actions";
import { canToggleSourceAudio } from "@/timeline/audio-separation";
import {
	activateScope,
	clearActiveScope,
	type ScopeEntry,
} from "@/selection/scope";
import { useCommittedRef } from "@/hooks/use-committed-ref";

export function useEditorActions() {
	const editor = useEditor();
	const { selectedClips, setClipSelection } = useClipSelection();
	const { selectedKeyframes, clearKeyframeSelection } = useKeyframeSelection();
	const selectedMaskPointSelection = useEditor((e) =>
		e.selection.getSelectedMaskPointSelection(),
	);
	const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
	const rippleEditingEnabled = useTimelineStore((s) => s.rippleEditingEnabled);
	const toggleRippleEditing = useTimelineStore((s) => s.toggleRippleEditing);
	const hasTimelineSelection =
		selectedClips.length > 0 ||
		selectedKeyframes.length > 0 ||
		selectedMaskPointSelection !== null;
	const hasTimelineSelectionRef = useCommittedRef(hasTimelineSelection);
	const clearTimelineSelectionRef = useCommittedRef(() => {
		editor.selection.clearSelection();
	});
	const clearTimelineActiveSelectionRef = useCommittedRef(() => {
		editor.selection.clearMostSpecificSelection();
	});
	const [timelineScope] = useState<ScopeEntry>(() => ({
		hasSelection: () => hasTimelineSelectionRef.current,
		clear: () => {
			clearTimelineSelectionRef.current();
		},
		clearActive: () => {
			clearTimelineActiveSelectionRef.current();
		},
	}));

	useEffect(() => {
		if (!hasTimelineSelection) {
			return;
		}

		return activateScope({ entry: timelineScope });
	}, [hasTimelineSelection, timelineScope]);

	useActionHandler(
		"toggle-play",
		() => {
			editor.playback.toggle();
		},
		undefined,
	);

	useActionHandler(
		"stop-playback",
		() => {
			editor.playback.pause();
			editor.playback.seek({ time: ZERO_MEDIA_TIME });
		},
		undefined,
	);

	useActionHandler(
		"seek-forward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			const delta = mediaTimeFromSeconds({ seconds });
			editor.playback.seek({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"seek-backward",
		(args) => {
			const seconds = args?.seconds ?? 1;
			const delta = mediaTimeFromSeconds({ seconds });
			editor.playback.seek({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-forward",
		() => {
			const fps = editor.project.getActive().settings.fps;
			const ticksPerFrame = mediaTime({
				ticks: Math.round(
					(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
				),
			});
			editor.playback.seek({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: ticksPerFrame,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"frame-step-backward",
		() => {
			const fps = editor.project.getActive().settings.fps;
			const ticksPerFrame = mediaTime({
				ticks: Math.round(
					(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
				),
			});
			editor.playback.seek({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: ticksPerFrame,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-forward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			const delta = mediaTimeFromSeconds({ seconds });
			editor.playback.seek({
				time: minMediaTime({
					a: editor.timeline.getTotalDuration(),
					b: addMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"jump-backward",
		(args) => {
			const seconds = args?.seconds ?? 5;
			const delta = mediaTimeFromSeconds({ seconds });
			editor.playback.seek({
				time: maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: subMediaTime({
						a: editor.playback.getCurrentTime(),
						b: delta,
					}),
				}),
			});
		},
		undefined,
	);

	useActionHandler(
		"goto-start",
		() => {
			editor.playback.seek({ time: ZERO_MEDIA_TIME });
		},
		undefined,
	);

	useActionHandler(
		"goto-end",
		() => {
			editor.playback.seek({ time: editor.timeline.getTotalDuration() });
		},
		undefined,
	);

	useActionHandler(
		"razor",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const tracks = editor.sequences.getActiveSequence().tracks;
			const clipsToRazor =
				selectedClips.length > 0
					? selectedClips
					: getClipsAtTime({
							tracks,
							time: currentTime,
						});

			if (clipsToRazor.length === 0) return;

			editor.timeline.razorClips({
				clips: clipsToRazor,
				splitTime: currentTime,
			});
		},
		undefined,
	);

	useActionHandler(
		"razor-left",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const tracks = editor.sequences.getActiveSequence().tracks;
			const clipsToRazor =
				selectedClips.length > 0
					? selectedClips
					: getClipsAtTime({
							tracks,
							time: currentTime,
						});

			if (clipsToRazor.length === 0) return;

			const rightSideClips = editor.timeline.razorClips({
				clips: clipsToRazor,
				splitTime: currentTime,
				retainSide: "right",
			});

			if (rippleEditingEnabled && rightSideClips.length > 0) {
				const firstRightClip = editor.timeline.getClipsWithTracks({
					clips: [rightSideClips[0]],
				})[0];
				if (firstRightClip) {
					editor.playback.seek({ time: firstRightClip.clip.startTime });
				}
			}
		},
		undefined,
	);

	useActionHandler(
		"razor-right",
		() => {
			const currentTime = editor.playback.getCurrentTime();
			const tracks = editor.sequences.getActiveSequence().tracks;
			const clipsToRazor =
				selectedClips.length > 0
					? selectedClips
					: getClipsAtTime({
							tracks,
							time: currentTime,
						});

			if (clipsToRazor.length === 0) return;

			editor.timeline.razorClips({
				clips: clipsToRazor,
				splitTime: currentTime,
				retainSide: "left",
			});
		},
		undefined,
	);

	useActionHandler(
		"delete-selected",
		() => {
			switch (editor.selection.getActiveSelectionKind()) {
				case "mask-points":
					if (!selectedMaskPointSelection) {
						return;
					}
					editor.timeline.deleteFreeformPathMaskPoints({
						trackId: selectedMaskPointSelection.trackId,
						clipId: selectedMaskPointSelection.clipId,
						maskId: selectedMaskPointSelection.maskId,
						pointIds: selectedMaskPointSelection.pointIds,
					});
					return;
				case "keyframes":
					if (selectedKeyframes.length === 0) {
						return;
					}
					editor.timeline.removeKeyframes({ keyframes: selectedKeyframes });
					clearKeyframeSelection();
					return;
				case "clips":
					if (selectedClips.length === 0) {
						return;
					}
					editor.timeline.deleteClips({
						clips: selectedClips,
					});
					return;
				default:
					return;
			}
		},
		undefined,
	);

	useActionHandler(
		"toggle-source-audio",
		() => {
			if (selectedClips.length !== 1) {
				return;
			}

			const selectedClip = editor.timeline.getClipsWithTracks({
				clips: selectedClips,
			})[0];
			if (!selectedClip) {
				return;
			}

			const projectItem = (() => {
				const { clip } = selectedClip;
				if (!hasMediaId(clip)) {
					return null;
				}

				return (
					editor.media
						.getProjectItems()
						.find((projectItem) => projectItem.id === clip.mediaId) ?? null
				);
			})();
			if (!canToggleSourceAudio(selectedClip.clip, projectItem)) {
				return;
			}

			editor.timeline.toggleSourceAudioSeparation({
				trackId: selectedClip.track.id,
				clipId: selectedClip.clip.id,
			});
		},
		undefined,
	);

	useActionHandler(
		"select-all",
		() => {
			const sequence = editor.sequences.getActiveSequence();
			const allClips = [
				...sequence.tracks.overlay,
				sequence.tracks.main,
				...sequence.tracks.audio,
			].flatMap((track) =>
				track.clips.map((clip) => ({
					trackId: track.id,
					clipId: clip.id,
				})),
			);
			setClipSelection({ clips: allClips });
		},
		undefined,
	);

	useActionHandler(
		"cancel-interaction",
		() => {
			if (!cancelInteraction()) {
				invokeAction("deselect-all");
			}
		},
		undefined,
	);

	useActionHandler(
		"deselect-all",
		() => {
			if (!clearActiveScope()) {
				editor.selection.clearMostSpecificSelection();
			}
		},
		undefined,
	);

	useActionHandler(
		"duplicate-selected",
		() => {
			editor.timeline.duplicateClips({
				clips: selectedClips,
			});
		},
		undefined,
	);

	useActionHandler(
		"toggle-clips-muted-selected",
		() => {
			editor.timeline.toggleClipsMuted({ clips: selectedClips });
		},
		undefined,
	);

	useActionHandler(
		"toggle-clips-visibility-selected",
		() => {
			editor.timeline.toggleClipsVisibility({ clips: selectedClips });
		},
		undefined,
	);

	useActionHandler(
		"toggle-marker",
		() => {
			editor.sequences.toggleMarker({ time: editor.playback.getCurrentTime() });
		},
		undefined,
	);

	useActionHandler(
		"copy-selected",
		() => {
			editor.clipboard.copy();
		},
		undefined,
	);

	useActionHandler(
		"paste-copied",
		() => {
			editor.clipboard.paste();
		},
		undefined,
	);

	useActionHandler(
		"toggle-snapping",
		() => {
			toggleSnapping();
		},
		undefined,
	);

	useActionHandler(
		"toggle-ripple-editing",
		() => {
			toggleRippleEditing();
		},
		undefined,
	);

	useActionHandler(
		"undo",
		() => {
			editor.command.undo();
		},
		undefined,
	);

	useActionHandler(
		"redo",
		() => {
			editor.command.redo();
		},
		undefined,
	);

	// todo: potnetially unify these two actions:
	useActionHandler(
		"remove-project-item",
		(args) => {
			if (!args) return;
			editor.media.removeProjectItem({
				projectId: args.projectId,
				id: args.projectItemId,
			});
		},
		undefined,
	);

	useActionHandler(
		"remove-project-items",
		(args) => {
			if (!args) return;
			editor.media.removeProjectItems({
				projectId: args.projectId,
				ids: args.projectItemIds,
			});
		},
		undefined,
	);
}
