export { applyPlacement } from "./apply";
export { canClipGoOnTrack, validateClipTrackCompatibility } from "./compatibility";
export { getDefaultInsertIndexForTrack, getHighestInsertIndexForTrack } from "./insert-index";
export { MAIN_TRACK_NAME, enforceMainTrackStart, getEarliestMainTrackClip } from "./main-track";
export { resolveTrackPlacement } from "./resolve";
export { buildEmptyTrack } from "./track-factory";
export type {
	PlacementResult,
	PlacementStrategy,
	PlacementSubject,
	PlacementTimeSpan,
} from "./types";
