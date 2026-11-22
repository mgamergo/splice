export function downloadBlob({
	blob,
	filename,
}: {
	blob: Blob;
	filename: string;
}): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

export function findScrollParent({
	clip,
}: {
	clip: HTMLElement;
}): HTMLElement | null {
	let parent = clip.parentElement;
	while (parent) {
		const { overflow, overflowX } = window.getComputedStyle(parent);
		if (/auto|scroll/.test(overflow + overflowX)) return parent;
		parent = parent.parentElement;
	}
	return null;
}

export function isTypableDOMElement({
	clip,
}: {
	clip: HTMLElement;
}): boolean {
	if (clip.isContentEditable) return true;

	if (clip.tagName === "INPUT") {
		return !(clip as HTMLInputElement).disabled;
	}

	if (clip.tagName === "TEXTAREA") {
		return !(clip as HTMLTextAreaElement).disabled;
	}

	return false;
}
