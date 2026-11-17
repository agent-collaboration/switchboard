import type { WorkerOptions } from 'miniflare';

export const proofStartupModuleSource =
	"import './controlled-date.mjs'; export * from './application.mjs'; import application from './application.mjs'; export default application;";

interface ClockedWorkerApplication {
	readonly startup: string;
	readonly application: string;
	readonly clock: string;
}
type WorkerModuleSource =
	| (ClockedWorkerApplication & {
			readonly kind: 'production-proof';
			readonly host: 'auth' | 'gateway';
			readonly production: string;
			readonly signingObserver: string;
	  })
	| (ClockedWorkerApplication & { readonly kind: 'storage-proof' });

/** A separate startup module installs only the test Date mock, then loads the
 * unchanged application/production module bytes supplied by the frozen manifest. */
export function clockedWorkerManifest(
	source: WorkerModuleSource,
): NonNullable<WorkerOptions['config']['manifest']> {
	const production =
		source.kind === 'production-proof'
			? {
					[`production-${source.host}.mjs`]: { type: 'esm', contents: source.production } as const,
					'native-signature-observer.mjs': {
						type: 'esm',
						contents: source.signingObserver,
					} as const,
				}
			: {};
	return {
		mainModule: 'worker.mjs',
		modules: {
			'worker.mjs': {
				type: 'esm',
				contents: source.startup,
			},
			'controlled-date.mjs': { type: 'esm', contents: source.clock },
			'application.mjs': { type: 'esm', contents: source.application },
			...production,
		},
	};
}
