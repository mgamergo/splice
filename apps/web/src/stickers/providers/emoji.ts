import { buildStickerId, parseStickerId } from "../sticker-id";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "../types";

/**
 * Emoji from Fluent Emoji Flat (MIT). Each emoji is served as SVG by
 * `/api/stickers/emoji/<name>`, so a sticker resolves without loading the set.
 */
const EMOJI_PROVIDER_ID = "emoji";
const DEFAULT_SEARCH_LIMIT = 100;

/** Category order in the browse view, most used first. */
const CATEGORY_ORDER = [
	"Smileys & Emotion",
	"People & Body",
	"Animals & Nature",
	"Food & Drink",
	"Activities",
	"Travel & Places",
	"Objects",
	"Symbols",
	"Flags",
];

const SKIN_TONES = ["light", "medium-light", "medium", "medium-dark", "dark"];

export type EmojiRecord = {
	name: string;
	category: string;
	/** The emoji itself, when the set maps a character to it. */
	char: string | null;
};

export function buildEmojiUrl({ name }: { name: string }): string {
	return `/api/stickers/emoji/${encodeURIComponent(name)}`;
}

/**
 * Emoji in browse order. A skin-tone variant ("thumbs-up-dark") is left out
 * when its base emoji is in the set.
 */
export function buildEmojiIndex({
	categories,
	chars,
}: {
	categories: Record<string, string[]>;
	chars: Record<string, string>;
}): EmojiRecord[] {
	const charByName = new Map<string, string>();
	for (const [codepoints, name] of Object.entries(chars)) {
		if (charByName.has(name)) continue;
		charByName.set(
			name,
			String.fromCodePoint(
				...codepoints.split("-").map((hex) => Number.parseInt(hex, 16)),
			),
		);
	}
	const names = new Set(Object.values(categories).flat());
	const isToneVariant = (name: string) =>
		SKIN_TONES.some(
			(tone) =>
				name.endsWith(`-${tone}`) &&
				names.has(name.slice(0, -tone.length - 1)),
		);
	const ordered = [
		...CATEGORY_ORDER.filter((category) => category in categories),
		...Object.keys(categories).filter(
			(category) => !CATEGORY_ORDER.includes(category),
		),
	];
	return ordered.flatMap((category) =>
		categories[category]
			.filter((name) => !isToneVariant(name))
			.map((name) => ({
				name,
				category,
				char: charByName.get(name) ?? null,
			})),
	);
}

/** Emoji whose name contains every word of the query, or that are the query. */
export function filterEmoji({
	emoji,
	query,
}: {
	emoji: EmojiRecord[];
	query: string;
}): EmojiRecord[] {
	const trimmed = query.trim();
	const words = trimmed.toLowerCase().split(/[\s-]+/).filter(Boolean);
	if (words.length === 0) return emoji;
	return emoji.filter(
		({ name, char }) =>
			char === trimmed || words.every((word) => name.includes(word)),
	);
}

let emojiPromise: Promise<EmojiRecord[]> | null = null;

function loadEmoji(): Promise<EmojiRecord[]> {
	emojiPromise ??= Promise.all([
		import("@iconify-json/fluent-emoji-flat/metadata.json"),
		import("@iconify-json/fluent-emoji-flat/chars.json"),
	])
		.then(([metadata, chars]) =>
			buildEmojiIndex({
				categories: metadata.default.categories,
				chars: chars.default,
			}),
		)
		.catch((error) => {
			console.error("Failed to load emoji:", error);
			emojiPromise = null;
			return [];
		});
	return emojiPromise;
}

function toStickerItem({ emoji }: { emoji: EmojiRecord }): StickerItem {
	return {
		id: buildStickerId({
			providerId: EMOJI_PROVIDER_ID,
			providerValue: emoji.name,
		}),
		provider: EMOJI_PROVIDER_ID,
		name: emoji.name.replaceAll("-", " "),
		previewUrl: buildEmojiUrl({ name: emoji.name }),
		metadata: { category: emoji.category, char: emoji.char },
	};
}

export const emojiProvider: StickerProvider = {
	id: EMOJI_PROVIDER_ID,
	async search({
		query,
		options,
	}: {
		query: string;
		options?: { limit?: number };
	}): Promise<StickerSearchResult> {
		const matches = filterEmoji({ emoji: await loadEmoji(), query });
		const limit = Math.max(1, options?.limit ?? DEFAULT_SEARCH_LIMIT);
		return {
			items: matches.slice(0, limit).map((emoji) => toStickerItem({ emoji })),
			total: matches.length,
			hasMore: matches.length > limit,
		};
	},
	async browse({
		options,
	}: {
		options?: { page?: number; limit?: number };
	}): Promise<StickerBrowseResult> {
		const emoji = await loadEmoji();
		if (options?.limit !== undefined) {
			const limit = Math.max(1, options.limit);
			return {
				sections: [
					{
						id: "all",
						items: emoji.slice(0, limit).map((each) => toStickerItem({ emoji: each })),
						hasMore: emoji.length > limit,
						layout: "grid",
					},
				],
			};
		}
		const byCategory = Map.groupBy(emoji, ({ category }) => category);
		return {
			sections: [...byCategory].map(([category, records]) => ({
				id: category,
				title: category,
				items: records.map((each) => toStickerItem({ emoji: each })),
				hasMore: false,
				layout: "grid",
			})),
		};
	},
	resolveUrl({
		stickerId,
	}: {
		stickerId: string;
		options?: { width?: number; height?: number };
	}): string {
		const { providerValue } = parseStickerId({ stickerId });
		return buildEmojiUrl({ name: providerValue });
	},
};
