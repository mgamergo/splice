/**
 * The wire protocol between `splice` (the local server), the editor tab and
 * `splice mcp`. Messages are JSON-RPC 2.0.
 */

export const BRIDGE_PATHS = {
	/** WebSocket the editor tab connects to. */
	tab: "/splice/tab",
	/** HTTP endpoint `splice mcp` posts JSON-RPC requests to. */
	rpc: "/splice/rpc",
	/** Unauthenticated liveness check. */
	health: "/splice/health",
	/** The tab posts its token here to get the cookie that authorizes media requests. */
	session: "/splice/session",
	/** Prefix for files under the Footage folder: `/splice/media/<path>`. */
	media: "/splice/media/",
	/** The editor tab's own calls to `splice`: transcripts, spellings and exports. */
	api: "/splice/api",
} as const;

/** The URL fragment key that hands the bridge token to the editor tab. */
export const TOKEN_FRAGMENT_KEY = "splice-token";

export const SERVER_NAME = "splice";

/** Methods the server forwards to the editor tab. */
export const TAB_METHODS = [
	"editor.getState",
	"editor.apply",
	"editor.listItems",
	"editor.importItems",
	"editor.rawSequence",
	"editor.roughCut",
	"editor.roughCutSources",
	"editor.takesList",
	"editor.audioSources",
	"editor.addCaptions",
	"editor.captionCues",
	"editor.correctCaption",
	"editor.styleUpdatePreview",
	"editor.styleUpdateApply",
	"editor.graphicsPlan",
	"editor.graphicsApply",
	"editor.graphicsList",
	"editor.shortStyle",
	"editor.shortHook",
	"editor.shortCaptionPlacement",
	"editor.shortSrt",
	"editor.finalizeCut",
	"editor.checkpointStatus",
	"editor.checkpointCompare",
	"editor.issuesList",
	"editor.dismissIssue",
	"editor.addMusic",
	"editor.updateMusic",
	"editor.removeMusic",
	"editor.mixLoudness",
	"editor.mixStatus",
	"editor.cutTranscript",
	"editor.transcriptSelection",
] as const;
export type TabMethod = (typeof TAB_METHODS)[number];

export function isTabMethod(method: string): method is TabMethod {
	return (TAB_METHODS as readonly string[]).includes(method);
}

/** Methods the server answers itself. */
export const SERVER_METHODS = [
	"server.status",
	"footage.list",
	"transcribe.start",
	"transcribe.status",
	"loudness.measure",
	"transcript.words",
	"pauses.detect",
	"exports.list",
] as const;
export type ServerMethod = (typeof SERVER_METHODS)[number];

export function isServerMethod(method: string): method is ServerMethod {
	return (SERVER_METHODS as readonly string[]).includes(method);
}

/** Sent by the tab as its first message; the server closes the socket on a bad token. */
export const TAB_HELLO = "tab.hello";
/** Notification from the tab whenever its command revision changes. */
export const STATE_CHANGED = "state.changed";
/** Notification when the creator interacts with the editor. */
export const EDITOR_ACTIVITY = "editor.activity";

/** A project's format, chosen when it's created. */
export const SHORT_STYLES = ["explainer", "raw"] as const;
export type ShortStyle = (typeof SHORT_STYLES)[number];
export const SHORT_STYLE_LABELS: Record<ShortStyle, string> = {
	explainer: "Explainer",
	raw: "Raw",
};

export type ProjectFormat = "horizontal" | "short";

export const PROJECT_FORMATS: Record<
	ProjectFormat,
	{ label: string; width: number; height: number; fps: number }
> = {
	horizontal: { label: "Horizontal", width: 1920, height: 1080, fps: 30 },
	short: { label: "Short", width: 1080, height: 1920, fps: 30 },
};

export interface EditorState {
	revision: number;
	project: {
		id: string;
		name: string;
		format: ProjectFormat;
		shortStyle?: ShortStyle;
	} | null;
	/** The active sequence; `editor.apply` must name it. */
	sequenceId: string | null;
	/** Compact text form of the active sequence, see `buildSequenceDigest`. */
	digest: string;
}

/**
 * The cookie that authorizes `/splice/media/*` requests from the editor tab.
 * Browsers share cookies across ports, so the name includes the port: two
 * splice instances on one machine keep separate keys.
 */
export function sessionCookieName(port: number): string {
	return `splice_session_${port}`;
}

/**
 * Whether a path is a plain relative path under Footage: forward slashes, no
 * empty, "." or ".." segments. URLs would otherwise normalize ".." away.
 */
export function isFootagePath(path: string): boolean {
	return path
		.split("/")
		.every(
			(segment) =>
				segment !== "" &&
				segment !== "." &&
				segment !== ".." &&
				!segment.includes("\\") &&
				!segment.includes("\0"),
		);
}

/** The URL of a file under Footage, for a path relative to that folder with forward slashes. */
export function mediaUrlForPath(path: string): string {
	return `${BRIDGE_PATHS.media}${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The media route's verified file version and optional SHA-256 of its bytes. */
export const MEDIA_VERSION_HEADER = "x-splice-media-version";
export const MEDIA_CONTENT_HEADER = "x-splice-media-sha256";
export const MEDIA_VERSION_PARAM = "version";

/** The `audio` query value that asks `splice` for a file's audio with noise reduction, as WAV. */
export const DENOISED_AUDIO = "denoised";

/** The URL of a Footage file's noise-reduced audio, rendered by `splice` on first request. */
export function denoisedAudioUrlForPath(path: string): string {
	return `${mediaUrlForPath(path)}?audio=${DENOISED_AUDIO}`;
}

/** A file under the Footage folder, as `footage.list` reports it. */
export interface FootageFile {
	/** Relative to the Footage folder, with forward slashes. */
	path: string;
	size: number;
	modifiedAt: string;
	contentType: string;
}

/** A project item as `editor.listItems` reports it. */
export interface ItemSummary {
	id: string;
	name: string;
	type: "video" | "audio" | "image";
	/** Seconds. */
	duration: number | null;
	/** Set for items that reference a file under Footage. */
	path: string | null;
	/** The file is no longer in Footage. */
	missing: boolean;
}

export type { RoughCutSources } from "./ops";

export interface ImportItemsResult {
	imported: ItemSummary[];
	failed: Array<{ path: string; error: string }>;
}

/** Source-relative timing in seconds. Word probabilities are estimates from whisper.cpp. */
export interface TranscriptWord {
	start: number;
	end: number;
	text: string;
	probability: number;
}

export interface Transcript {
	/** Relative to Footage. */
	path: string;
	durationSeconds: number;
	language: string;
	model: string;
	segments: Array<{
		start: number;
		end: number;
		text: string;
		words: TranscriptWord[];
	}>;
}

export interface ServerStatus {
	tabConnected: boolean;
	/** The last revision the tab reported, or null before it reported one. */
	revision: number | null;
	root: string;
}

export const RPC_ERRORS = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	TAB_NOT_CONNECTED: -32001,
	TAB_TIMEOUT: -32002,
	TAB_DISCONNECTED: -32003,
	/** The creator pressed Stop in the editor; agent writes are refused. */
	AGENT_BLOCKED: -32004,
	INTERNAL: -32603,
} as const;

/** Close codes the server uses on the tab socket. */
export const TAB_CLOSE_CODES = {
	UNAUTHORIZED: 4401,
	/** A newer tab connected and took over. */
	SUPERSEDED: 4000,
} as const;

export type RpcId = number | string;

export interface RpcRequest {
	jsonrpc: "2.0";
	id: RpcId;
	method: string;
	params?: unknown;
}

export interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

export type RpcResponse =
	| { jsonrpc: "2.0"; id: RpcId | null; result: unknown }
	| { jsonrpc: "2.0"; id: RpcId | null; error: RpcError };

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one JSON-RPC message, or returns null if the text isn't one. */
export function parseRpcMessage(text: string): RpcMessage | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.jsonrpc !== "2.0") {
		return null;
	}
	const id = value.id;
	const hasId = typeof id === "number" || typeof id === "string";
	if (typeof value.method === "string") {
		return hasId
			? { jsonrpc: "2.0", id, method: value.method, params: value.params }
			: { jsonrpc: "2.0", method: value.method, params: value.params };
	}
	if (!hasId && id !== null) {
		return null;
	}
	const responseId = hasId ? id : null;
	if ("result" in value) {
		return { jsonrpc: "2.0", id: responseId, result: value.result };
	}
	const error = value.error;
	if (
		isRecord(error) &&
		typeof error.code === "number" &&
		typeof error.message === "string"
	) {
		return {
			jsonrpc: "2.0",
			id: responseId,
			error: { code: error.code, message: error.message, data: error.data },
		};
	}
	return null;
}

export function isRpcRequest(message: RpcMessage): message is RpcRequest {
	return "method" in message && "id" in message;
}

export function isRpcNotification(
	message: RpcMessage,
): message is RpcNotification {
	return "method" in message && !("id" in message);
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
	return !("method" in message);
}
