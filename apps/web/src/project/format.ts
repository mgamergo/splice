import type { ProjectFormat, ShortStyle } from "@splice/bridge";
import type { TProject } from "./types";

export function projectFormat({
	project,
}: {
	project: TProject;
}): ProjectFormat {
	return project.settings.format ?? "horizontal";
}

export function projectShortStyle({
	project,
}: {
	project: TProject;
}): ShortStyle | undefined {
	if (projectFormat({ project }) === "short")
		return project.settings.shortStyle === "raw" ? "raw" : "explainer";
}
