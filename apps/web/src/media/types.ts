import type { ProjectItemData } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

export interface ProjectItem
	extends Omit<ProjectItemData, "size" | "lastModified"> {
	file: File;
	url?: string;
}
