import { it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { observeOrganizationBrowser } from '#sign-in-test-support/test-fixtures/organization-browser-scenario';

useControlledSignInClock();

// The host lane runs this file with default workerd/D1 and SIGN_IN_TEST_HOST=node.
it('people: real Chrome switches twice, completes the original native CLI, and reads back lost and refused switch replies', async (): Promise<void> => {
	await observeOrganizationBrowser('chooser');
});

it('people: real Chrome keeps the latest checked lookup and list page in a read-only accessible people page', async (): Promise<void> => {
	await observeOrganizationBrowser('people');
});
