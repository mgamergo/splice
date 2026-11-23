import { BRIDGE_PATHS } from "@splice/bridge";
import { readBridgeToken } from "./token";

let pending: Promise<boolean> | null = null;

/**
 * Trades the bridge token for the cookie that lets media elements and mediabunny
 * read footage from `splice`. Returns false outside `splice` or without a token.
 */
export function ensureMediaSession(): Promise<boolean> {
	pending ??= (async () => {
		const token = readBridgeToken();
		if (!token) return false;
		try {
			const response = await fetch(BRIDGE_PATHS.session, {
				method: "POST",
				credentials: "same-origin",
				headers: { authorization: `Bearer ${token}` },
			});
			return response.ok;
		} catch {
			return false;
		}
	})().finally(() => {
		pending = null;
	});
	return pending;
}
