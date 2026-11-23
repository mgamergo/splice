import { TOKEN_FRAGMENT_KEY } from "@splice/bridge";

const STORAGE_KEY = "splice-bridge-token";

/**
 * Moves the bridge token from the URL fragment (where `splice` puts it in the
 * link it prints) into local storage, and strips it from the address bar.
 */
export function captureBridgeToken(): void {
	const params = new URLSearchParams(window.location.hash.slice(1));
	const token = params.get(TOKEN_FRAGMENT_KEY);
	if (!token) {
		return;
	}
	try {
		window.localStorage.setItem(STORAGE_KEY, token);
	} catch {
		// Storage can be blocked; the tab then simply stays unconnected.
	}
	params.delete(TOKEN_FRAGMENT_KEY);
	const hash = params.toString();
	const { pathname, search } = window.location;
	window.history.replaceState(
		window.history.state,
		"",
		`${pathname}${search}${hash ? `#${hash}` : ""}`,
	);
}

export function readBridgeToken(): string | null {
	try {
		return window.localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}
