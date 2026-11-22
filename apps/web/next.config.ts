import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	images: {
		// Sticker providers.
		remotePatterns: [
			{ protocol: "https", hostname: "api.iconify.design" },
			{ protocol: "https", hostname: "api.simplesvg.com" },
			{ protocol: "https", hostname: "api.unisvg.com" },
			{ protocol: "https", hostname: "cdn.brandfetch.io" },
		],
	},
};

export default nextConfig;
