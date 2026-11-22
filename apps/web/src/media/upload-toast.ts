import { toast } from "sonner";

export interface MediaUploadToastResult {
	uploadedCount: number;
	projectItemNames?: string[];
}

function getProjectItemLabel({ count }: { count: number }): string {
	return count === 1 ? "project item" : "project items";
}

function waitForNextPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

export async function showMediaUploadToast<T extends MediaUploadToastResult>({
	filesCount,
	promise,
}: {
	filesCount: number;
	promise: Promise<T> | (() => Promise<T>);
}) {
	const run = typeof promise === "function" ? promise : () => promise;
	const toastPromise = toast.promise(async () => {
		await waitForNextPaint();
		return run();
	}, {
		loading: `Uploading ${getProjectItemLabel({ count: filesCount })}...`,
		success: ({ uploadedCount, projectItemNames }) => {
			if (uploadedCount === 1) {
				const projectItemName = projectItemNames?.[0];
				return projectItemName
					? `${projectItemName} has been uploaded`
					: "1 project item has been uploaded";
			}

			if (uploadedCount > 1) {
				return `${uploadedCount} project items have been uploaded`;
			}

			return "No project items were uploaded";
		},
		error: `Failed to upload ${getProjectItemLabel({ count: filesCount })}`,
	});

	return toastPromise.unwrap();
}
