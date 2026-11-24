import { BRIDGE_PATHS, parseRpcMessage } from "@splice/bridge";
import type { ExportFileKind, TabApiMethod } from "@splice/bridge/delivery";
import { readBridgeToken } from "./token";

/** `splice` refused a call, or isn't there to answer it. */
export class SpliceApiError extends Error {}

function authorization(): string {
	const token = readBridgeToken();
	if (!token)
		throw new SpliceApiError(
			"This needs splice. Open the editor from the link splice prints.",
		);
	return `Bearer ${token}`;
}

async function readResult(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!response.ok)
		throw new SpliceApiError(
			`splice answered ${response.status}${text ? `: ${text}` : ""}`,
		);
	const message = parseRpcMessage(text);
	if (!message || "method" in message)
		throw new SpliceApiError("splice sent an unexpected answer.");
	if ("error" in message) throw new SpliceApiError(message.error.message);
	return message.result;
}

/** Calls one of `splice`'s own methods for the editor tab. */
export async function callSplice({
	method,
	params,
}: {
	method: TabApiMethod;
	params?: unknown;
}): Promise<unknown> {
	const response = await fetch(BRIDGE_PATHS.api, {
		method: "POST",
		headers: {
			authorization: authorization(),
			"content-type": "application/json",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return readResult(response);
}

/** Chunks stay well under Bun's 128 MB request limit. */
const UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;

/** Writes one file of an export pair to `splice`'s staging folder, in order, chunk by chunk. */
export async function uploadExportFile({
	exportId,
	kind,
	body,
	signal,
}: {
	exportId: string;
	kind: ExportFileKind;
	body: Blob;
	signal?: AbortSignal;
}): Promise<void> {
	let offset = 0;
	do {
		const chunk = body.slice(offset, offset + UPLOAD_CHUNK_BYTES);
		const response = await fetch(
			`${BRIDGE_PATHS.api}/exports/${exportId}/${kind}?offset=${offset}`,
			{
				method: "PUT",
				headers: { authorization: authorization() },
				body: chunk,
				signal,
			},
		);
		await readResult(response);
		offset += chunk.size;
	} while (offset < body.size);
}
