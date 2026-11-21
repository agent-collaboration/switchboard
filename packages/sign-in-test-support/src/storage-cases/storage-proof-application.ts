import { build } from 'esbuild';

/** The component runner and storage host freeze the same source-bundled application. */
export async function buildStorageProofApplication(repositoryRoot: string): Promise<string> {
	const bundled = await build({
		absWorkingDir: repositoryRoot,
		entryPoints: ['packages/sign-in-test-support/src/storage-cases/storage-proof-worker.ts'],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		conditions: ['workerd', 'worker', 'browser'],
		mainFields: ['module', 'main'],
		external: ['cloudflare:workers', 'node:*'],
		logLevel: 'silent',
	});
	const module = bundled.outputFiles[0];
	if (module === undefined) throw new Error('Storage Worker bundle is empty');
	return module.text;
}
