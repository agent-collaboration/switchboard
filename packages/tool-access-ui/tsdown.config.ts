import { readdirSync } from 'node:fs';

import { defineConfig } from 'tsdown';

/** Every registry primitive is published as `./ui/<name>` for sibling shadcn
 * packages whose `ui` alias points here. */
const primitiveEntries = Object.fromEntries(
	readdirSync(new URL('./src/components/ui/', import.meta.url))
		.filter((fileName) => fileName.endsWith('.tsx'))
		.map((fileName) => {
			const primitiveName = fileName.slice(0, -'.tsx'.length);
			return [`ui/${primitiveName}`, `src/components/ui/${fileName}`];
		}),
);

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		'panel-fixture': 'src/panel-demo/panel-fixture.ts',
		server: 'src/server.ts',
		...primitiveEntries,
	},
	format: 'esm',
	dts: true,
	clean: true,
	tsconfig: 'tsconfig.build.json',
	outDir: 'dist',
	outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
