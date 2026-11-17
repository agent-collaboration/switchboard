import { afterAll, vi } from 'vitest';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
export function useControlledSignInClock(): void {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(controlledSignInClock.now());
	afterAll(() => vi.useRealTimers());
}
