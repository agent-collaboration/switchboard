import { expect, it } from 'vitest';

import { AuthProofCloseError } from '#sign-in-test-support/test-fixtures/auth-proof-forwarder-lifecycle';
import { closeOrganizationBrowserScenario } from '#sign-in-test-support/test-fixtures/organization-browser-cleanup';

it('preserves a scenario failure when cleanup succeeds', async (): Promise<void> => {
	const scenarioError = new Error('People anchor assertion failed');

	await expect(
		closeOrganizationBrowserScenario({
			failure: { kind: 'failed', error: scenarioError },
			close: async (): Promise<void> => {},
		}),
	).rejects.toBe(scenarioError);
});

it('retains the original failure first when auth proof cleanup also fails', async (): Promise<void> => {
	const earlierCause = new Error('Existing scenario cause');
	const scenarioError = Object.freeze(
		new Error('People anchor assertion failed', { cause: earlierCause }),
	);
	const closeError = new AuthProofCloseError({ kind: 'pendingAtClose', pendingRequests: 1 });

	await expect(
		closeOrganizationBrowserScenario({
			failure: { kind: 'failed', error: scenarioError },
			close: async (): Promise<never> => {
				throw closeError;
			},
		}),
	).rejects.toMatchObject({
		cause: scenarioError,
		errors: [scenarioError, closeError],
	});
	expect(scenarioError.cause).toBe(earlierCause);
});

it('keeps an auth proof cleanup failure fatal after a successful scenario', async (): Promise<void> => {
	const closeError = new AuthProofCloseError({ kind: 'pendingAtClose', pendingRequests: 1 });

	await expect(
		closeOrganizationBrowserScenario({
			failure: { kind: 'none' },
			close: async (): Promise<never> => {
				throw closeError;
			},
		}),
	).rejects.toBe(closeError);
});

it('completes when neither the scenario nor cleanup failed', async (): Promise<void> => {
	await expect(
		closeOrganizationBrowserScenario({
			failure: { kind: 'none' },
			close: async (): Promise<void> => {},
		}),
	).resolves.toBeUndefined();
});
