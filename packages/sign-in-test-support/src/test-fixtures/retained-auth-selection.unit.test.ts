import { expect, it } from 'vitest';

import { selectRetainedAuthObservations } from '#sign-in-test-support/test-fixtures/auth-verification-cli';

it('admits the B2 selections when an unrelated agent case is outside the original agent allowlist', (): void => {
	const root = '/checkout';
	const organization = {
		name: 'organization stamp: observed setup',
		file: `${root}/packages/sign-in-test-support/src/organization-statement.host.e2e.test.ts`,
	};
	const revision = {
		name: 'authorization fence: observed atomic write',
		file: `${root}/packages/sign-in-test-support/src/authorization-fence.host.e2e.test.ts`,
	};
	const unrelated = {
		name: 'agent: newly offered observation',
		file: `${root}/packages/sign-in-test-support/src/other.host.e2e.test.ts`,
	};

	const selections = selectRetainedAuthObservations([organization, revision, unrelated], root);

	expect(selections).toEqual({
		organization: [organization],
		'revision-fence': [revision],
	});
});
