import { describe, expect, test } from "bun:test";
import metadata from "@iconify-json/fluent-emoji-flat/metadata.json";
import chars from "@iconify-json/fluent-emoji-flat/chars.json";
import { GET } from "@/app/api/stickers/emoji/[name]/route";
import {
	buildEmojiIndex,
	emojiProvider,
	filterEmoji,
} from "../providers/emoji";

const emoji = buildEmojiIndex({ categories: metadata.categories, chars });

describe("emoji stickers", () => {
	test("lists smileys first and leaves out skin-tone variants of a listed emoji", () => {
		expect(emoji[0].category).toBe("Smileys & Emotion");
		const names = new Set(emoji.map(({ name }) => name));
		expect(names.has("thumbs-up")).toBe(true);
		expect(names.has("thumbs-up-dark")).toBe(false);
		// A name ending in a tone word is kept when there is no base emoji.
		expect(names.has("vertical-traffic-light")).toBe(true);
	});

	test("finds emoji by every word of the query or by the character", () => {
		expect(
			filterEmoji({ emoji, query: "thumbs up" }).map(({ name }) => name),
		).toContain("thumbs-up");
		expect(filterEmoji({ emoji, query: "😂" }).map(({ name }) => name)).toEqual(
			["face-with-tears-of-joy"],
		);
		expect(filterEmoji({ emoji, query: "zzzz-not-an-emoji" })).toEqual([]);
	});

	test("resolves a sticker ID to the emoji route", () => {
		expect(emojiProvider.resolveUrl({ stickerId: "emoji:red-heart" })).toBe(
			"/api/stickers/emoji/red-heart",
		);
	});

	test("serves an emoji as a sized SVG and refuses unknown names", async () => {
		const response = await GET(new Request("http://splice/"), {
			params: Promise.resolve({ name: "red-heart" }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
		const svg = await response.text();
		expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 32 32">');
		const missing = await GET(new Request("http://splice/"), {
			params: Promise.resolve({ name: "toString" }),
		});
		expect(missing.status).toBe(404);
	});
});
