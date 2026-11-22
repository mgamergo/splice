import { useEffect } from "react";

export function useResizeObserver({
	ref,
	onResize,
}: {
	ref: React.RefObject<HTMLElement | null>;
	onResize: (entry: ResizeObserverEntry) => void;
}) {
	useEffect(() => {
		const clip = ref.current;
		if (!clip) return;

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				onResize(entry);
			}
		});

		observer.observe(clip);

		return () => {
			observer.disconnect();
		};
	}, [ref, onResize]);
}
