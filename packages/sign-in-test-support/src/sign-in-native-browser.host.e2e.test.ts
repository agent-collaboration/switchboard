import { it, vi } from 'vitest';

import { initialSignInTestTime } from '#sign-in-test-support/test-fixtures/controlled-sign-in-time';
import { observeNativeSignInBrowser } from '#sign-in-test-support/test-fixtures/native-browser-scenario';

it.each(['node', 'cloudflare'] as const)(
	'F native Better Auth browser journey on %s',
	async (host): Promise<void> => {
		// The existing Node proof host uses Vitest's Date seam. Protocol timers stay real.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(initialSignInTestTime);
		try {
			await observeNativeSignInBrowser(host);
		} finally {
			vi.useRealTimers();
		}
	},
);
