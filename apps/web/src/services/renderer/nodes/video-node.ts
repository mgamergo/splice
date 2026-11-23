import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";
import type { MediaData } from "@/media/types";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: MediaData;
	mediaId: string;
}

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVisualSourceNodeState
> {}
