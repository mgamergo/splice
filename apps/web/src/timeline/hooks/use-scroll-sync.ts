import { useEffect, useRef } from "react";

interface UseScrollSyncProps {
	rulerScrollRef?: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	trackLabelsScrollRef?: React.RefObject<HTMLDivElement | null>;
	markersScrollRef?: React.RefObject<HTMLDivElement | null>;
}

export function useScrollSync({
	tracksScrollRef,
	rulerScrollRef,
	trackLabelsScrollRef,
	markersScrollRef,
}: UseScrollSyncProps) {
	const isUpdatingRef = useRef(false);
	const lastRulerSync = useRef(0);
	const lastTracksSync = useRef(0);
	const lastVerticalSync = useRef(0);
	const lastMarkersSync = useRef(0);

	useEffect(() => {
		const rulerViewport = rulerScrollRef?.current ?? null;
		const tracksViewport = tracksScrollRef.current;
		const trackLabelsViewport = trackLabelsScrollRef?.current;
		const markersViewport = markersScrollRef?.current;
		let handleMarkersScroll: (() => void) | null = null;

		if (!tracksViewport) return;

		const syncScrollLeft = ({
			target,
			scrollLeft,
		}: {
			target: HTMLDivElement | null | undefined;
			scrollLeft: number;
		}) => {
			if (target) {
				target.scrollLeft = scrollLeft;
			}
		};

		const handleRulerScroll = () => {
			const now = Date.now();
			if (isUpdatingRef.current || now - lastRulerSync.current < 16) return;
			lastRulerSync.current = now;
			isUpdatingRef.current = true;
			tracksViewport.scrollLeft = rulerViewport?.scrollLeft ?? 0;
			syncScrollLeft({
				target: markersViewport,
				scrollLeft: rulerViewport?.scrollLeft ?? 0,
			});
			isUpdatingRef.current = false;
		};

		const handleTracksScroll = () => {
			const now = Date.now();
			if (isUpdatingRef.current || now - lastTracksSync.current < 16) return;
			lastTracksSync.current = now;
			isUpdatingRef.current = true;
			syncScrollLeft({
				target: rulerViewport,
				scrollLeft: tracksViewport.scrollLeft,
			});
			syncScrollLeft({
				target: markersViewport,
				scrollLeft: tracksViewport.scrollLeft,
			});
			isUpdatingRef.current = false;
		};

		if (rulerViewport && rulerViewport !== tracksViewport) {
			rulerViewport.addEventListener("scroll", handleRulerScroll);
		}
		if (tracksViewport !== rulerViewport) {
			tracksViewport.addEventListener("scroll", handleTracksScroll);
		}

		if (markersViewport) {
			handleMarkersScroll = () => {
				const now = Date.now();
				if (isUpdatingRef.current || now - lastMarkersSync.current < 16)
					return;
				lastMarkersSync.current = now;
				isUpdatingRef.current = true;
				const nextScrollLeft = markersViewport.scrollLeft;
				tracksViewport.scrollLeft = nextScrollLeft;
				syncScrollLeft({
					target: rulerViewport,
					scrollLeft: nextScrollLeft,
				});
				isUpdatingRef.current = false;
			};

			if (markersViewport !== tracksViewport) {
				markersViewport.addEventListener("scroll", handleMarkersScroll);
			}
		}

		if (trackLabelsViewport) {
			const handleTrackLabelsScroll = () => {
				const now = Date.now();
				if (isUpdatingRef.current || now - lastVerticalSync.current < 16)
					return;
				lastVerticalSync.current = now;
				isUpdatingRef.current = true;
				tracksViewport.scrollTop = trackLabelsViewport.scrollTop;
				isUpdatingRef.current = false;
			};

			const handleTracksVerticalScroll = () => {
				const now = Date.now();
				if (isUpdatingRef.current || now - lastVerticalSync.current < 16)
					return;
				lastVerticalSync.current = now;
				isUpdatingRef.current = true;
				trackLabelsViewport.scrollTop = tracksViewport.scrollTop;
				isUpdatingRef.current = false;
			};

			trackLabelsViewport.addEventListener("scroll", handleTrackLabelsScroll);
			tracksViewport.addEventListener("scroll", handleTracksVerticalScroll);

			return () => {
				if (rulerViewport && rulerViewport !== tracksViewport) {
					rulerViewport.removeEventListener("scroll", handleRulerScroll);
				}
				if (tracksViewport !== rulerViewport) {
					tracksViewport.removeEventListener("scroll", handleTracksScroll);
				}
				if (
					markersViewport &&
					markersViewport !== tracksViewport &&
					handleMarkersScroll
				) {
					markersViewport.removeEventListener(
						"scroll",
						handleMarkersScroll,
					);
				}
				trackLabelsViewport.removeEventListener(
					"scroll",
					handleTrackLabelsScroll,
				);
				tracksViewport.removeEventListener(
					"scroll",
					handleTracksVerticalScroll,
				);
			};
		}

		return () => {
			if (rulerViewport && rulerViewport !== tracksViewport) {
				rulerViewport.removeEventListener("scroll", handleRulerScroll);
			}
			if (tracksViewport !== rulerViewport) {
				tracksViewport.removeEventListener("scroll", handleTracksScroll);
			}
			if (
				markersViewport &&
				markersViewport !== tracksViewport &&
				handleMarkersScroll
			) {
				markersViewport.removeEventListener("scroll", handleMarkersScroll);
			}
		};
	}, [
		rulerScrollRef,
		tracksScrollRef,
		trackLabelsScrollRef,
		markersScrollRef,
	]);
}
