import type { ProjectFormat } from "@splice/bridge";
import type { TProject } from "./types";

export function projectFormat({
	project,
}: {
	project: TProject;
}): ProjectFormat {
	return project.settings.format ?? "horizontal";
}
