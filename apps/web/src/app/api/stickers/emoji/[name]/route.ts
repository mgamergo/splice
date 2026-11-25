import { icons } from "@iconify-json/fluent-emoji-flat";

/**
 * Rendered size. Stickers draw from the image's natural size, so the SVG
 * carries one large enough to stay sharp at 1080p.
 */
const SIZE = 512;

// eslint-disable-next-line opencut/prefer-object-params -- Next calls route handlers with (request, context).
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const { name } = await params;
	const icon = Object.hasOwn(icons.icons, name) ? icons.icons[name] : null;
	if (!icon) return new Response("Unknown emoji", { status: 404 });
	const width = icon.width ?? icons.width ?? 16;
	const height = icon.height ?? icons.height ?? 16;
	const scale = SIZE / Math.max(width, height);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}" viewBox="${icon.left ?? 0} ${icon.top ?? 0} ${width} ${height}">${icon.body}</svg>`;
	return new Response(svg, {
		headers: {
			"Content-Type": "image/svg+xml",
			"Cache-Control": "public, max-age=86400",
		},
	});
}
