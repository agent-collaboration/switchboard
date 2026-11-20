import { writeFile } from 'node:fs/promises';

import type { Reporter } from 'vitest/reporters';

/** Vitest's JSON reporter omits unhandled errors; retain their count without their sensitive bodies. */
export default class RuntimeErrorsReporter implements Reporter {
	async onTestRunEnd(_modules: readonly unknown[], errors: readonly unknown[]): Promise<void> {
		const destination = process.env.SIGN_IN_VERIFICATION_ERRORS_FILE;
		if (destination === undefined) throw new Error('Missing runtime-error report destination');
		await writeFile(destination, JSON.stringify(errors.length), { mode: 0o600, flag: 'wx' });
	}
}
