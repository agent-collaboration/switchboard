import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: ['src/index.ts', 'src/better-auth/index.ts', 'src/contracts/person-identity-contracts.ts'],
	format: 'esm',
	outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
	external: ['cloudflare:workers'],
});
