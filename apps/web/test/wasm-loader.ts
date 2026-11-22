import { plugin } from "bun";

// opencut-wasm is built for bundlers (`import * as wasm from "./x.wasm"`), which
// Bun's runtime can't load. This turns each .wasm import into an ES module that
// instantiates the binary with its JS glue imports and re-exports its exports.
plugin({
	name: "wasm-esm",
	setup(build) {
		build.onLoad({ filter: /\.wasm$/ }, async ({ path }) => {
			const module = new WebAssembly.Module(await Bun.file(path).arrayBuffer());
			const importSources = [
				...new Set(WebAssembly.Module.imports(module).map((entry) => entry.module)),
			];
			const exportNames = WebAssembly.Module.exports(module).map(
				(entry) => entry.name,
			);

			const contents = [
				...importSources.map(
					(source, index) =>
						`import * as import${index} from ${JSON.stringify(source)};`,
				),
				`const bytes = await Bun.file(${JSON.stringify(path)}).arrayBuffer();`,
				`const { instance } = await WebAssembly.instantiate(bytes, {`,
				...importSources.map(
					(source, index) => `\t${JSON.stringify(source)}: import${index},`,
				),
				`});`,
				...exportNames.map(
					(name) =>
						`export const ${name} = instance.exports[${JSON.stringify(name)}];`,
				),
			].join("\n");

			return { contents, loader: "js" };
		});
	},
});
