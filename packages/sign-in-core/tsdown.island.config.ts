import { defineConfig } from 'tsdown';

/** Browser islands are bundled whole, then embedded as text like the
 * stylesheet, so neither host reads files to serve them. */
export default defineConfig({
	entry: {
		'sign-in-pages-island': 'src/pages/islands/sign-in-pages-island.tsx',
	},
	format: 'esm',
	platform: 'browser',
	outDir: '__generated__/islands',
	outExtensions: () => ({ js: '.js' }),
	clean: true,
	dts: false,
	minify: true,
	tsconfig: 'tsconfig.build.json',
	deps: { alwaysBundle: [/.*/u], onlyBundle: false },
	define: { 'process.env.NODE_ENV': '"production"' },
});
