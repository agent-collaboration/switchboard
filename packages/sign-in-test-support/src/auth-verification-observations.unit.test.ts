import { expect, it } from 'vitest';

import {
	requireMatchingAuthObservations,
	selectAuthObservations,
	authJourneyExecutionPattern,
	authJourneyFiles,
	requireAdmittedRequestLimitCounters,
} from '#sign-in-test-support/test-fixtures/auth-verification-journeys';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	authHarnessRequestLimitsSchema,
	type AuthHarnessRequestLimits,
} from '#sign-in-test-support/test-fixtures/proof-bundle-artifacts';

useControlledSignInClock();

const realWorkerdCounter: AuthHarnessRequestLimits = {
	outerCounter: 'cloudflare-real-binding',
	backingFailure: 'none',
	observations: [],
};
const controlledPageCounter: AuthHarnessRequestLimits = {
	outerCounter: 'cloudflare-controlled-binding-stand-in',
	proofCase: 'service-page-exact-budget',
	backingFailure: 'none',
	observations: [],
};
const controlledPasskeyCounter: AuthHarnessRequestLimits = {
	...controlledPageCounter,
	proofCase: 'passkey-exact-budget',
};
const workerdBackingFailure: AuthHarnessRequestLimits = {
	...realWorkerdCounter,
	backingFailure: 'cloudflare-binding-rejects',
};

it('admits exactly one of each named controlled budget for people on workerd without real-counter credit', () => {
	expect(() =>
		requireAdmittedRequestLimitCounters({
			journey: 'people',
			signInHost: 'workerd',
			requestLimits: [
				realWorkerdCounter,
				controlledPageCounter,
				controlledPasskeyCounter,
				workerdBackingFailure,
			],
		}),
	).not.toThrow();
});

it.each(['agent', 'bootstrap', 'organization', 'revision-fence'] as const)(
	'rejects the controlled page counter outside people: %s',
	(journey) => {
		expect(() =>
			requireAdmittedRequestLimitCounters({
				journey,
				signInHost: 'workerd',
				requestLimits: [realWorkerdCounter, controlledPageCounter],
			}),
		).toThrow('counters differ');
	},
);

it('rejects the controlled page counter on Node even in the people journey', () => {
	expect(() =>
		requireAdmittedRequestLimitCounters({
			journey: 'people',
			signInHost: 'node',
			requestLimits: [
				{ outerCounter: 'node-fixed-window', backingFailure: 'none', observations: [] },
				{
					outerCounter: 'node-fixed-window',
					backingFailure: 'node-counter-throws',
					observations: [],
				},
				controlledPageCounter,
			],
		}),
	).toThrow('counters differ');
});

it.each([
	{ name: 'missing', standIns: [] },
	{ name: 'missing passkey', standIns: [controlledPageCounter] },
	{ name: 'missing page', standIns: [controlledPasskeyCounter] },
	{
		name: 'duplicated page replacing passkey',
		standIns: [controlledPageCounter, controlledPageCounter],
	},
	{
		name: 'duplicated passkey replacing page',
		standIns: [controlledPasskeyCounter, controlledPasskeyCounter],
	},
	{
		name: 'extra passkey',
		standIns: [controlledPageCounter, controlledPasskeyCounter, controlledPasskeyCounter],
	},
])('rejects $name controlled budget receipts', ({ standIns }) => {
	expect(() =>
		requireAdmittedRequestLimitCounters({
			journey: 'people',
			signInHost: 'workerd',
			requestLimits: [realWorkerdCounter, workerdBackingFailure, ...standIns],
		}),
	).toThrow('counters differ');
});

it.each([undefined, 'another-case'])(
	'rejects an unnamed or unrelated stand-in proof case: %s',
	(proofCase) => {
		expect(
			authHarnessRequestLimitsSchema.safeParse({ ...controlledPageCounter, proofCase }).success,
		).toBe(false);
	},
);

it('rejects a stand-in that also claims the separate backing-failure proof', () => {
	expect(() =>
		requireAdmittedRequestLimitCounters({
			journey: 'people',
			signInHost: 'workerd',
			requestLimits: [
				realWorkerdCounter,
				{ ...controlledPageCounter, backingFailure: 'cloudflare-binding-rejects' },
			],
		}),
	).toThrow('counters differ');
});

it('keeps real counters strict for other journeys and Node', () => {
	expect(() =>
		requireAdmittedRequestLimitCounters({
			journey: 'agent',
			signInHost: 'workerd',
			requestLimits: [realWorkerdCounter],
		}),
	).not.toThrow();
	expect(() =>
		requireAdmittedRequestLimitCounters({
			journey: 'people',
			signInHost: 'node',
			requestLimits: [
				{ outerCounter: 'node-fixed-window', backingFailure: 'none', observations: [] },
				{
					outerCounter: 'node-fixed-window',
					backingFailure: 'node-counter-throws',
					observations: [],
				},
			],
		}),
	).not.toThrow();
	expect(() =>
		requireAdmittedRequestLimitCounters({
			journey: 'agent',
			signInHost: 'node',
			requestLimits: [realWorkerdCounter],
		}),
	).toThrow('counters differ');
});

const root = '/proof-checkout';
const inventory = [
	{ file: '/proof-checkout/issuer.ts', name: 'issuer > agent: allowed effect' },
	{ file: '/proof-checkout/faults.ts', name: 'agent: rejects outcome failure' },
	{ file: '/proof-checkout/issuer.ts', name: 'issuer > bootstrap: native owner' },
] as const;

it.each(['organization', 'revision-fence'] as const)(
	'%s retains both recovery stores and both recovery hosts without importing real-central B2e',
	(journey): void => {
		const storageFile = 'packages/sign-in-test-support/src/sign-in-storage.host.e2e.test.ts';
		const relayFile = 'packages/sign-in-test-support/src/fleet-admin-relay.host.e2e.test.ts';
		const offered = [
			{ file: `${root}/${storageFile}`, name: 'd1-workerd > central empty: setup recovers' },
			{ file: `${root}/${storageFile}`, name: 'better-sqlite3 > central empty: setup recovers' },
			{ file: `${root}/${storageFile}`, name: 'd1-workerd > central forgot: push 503 probes none' },
			{
				file: `${root}/${storageFile}`,
				name: 'better-sqlite3 > central forgot: push 503 probes none',
			},
			{
				file: `${root}/packages/sign-in-test-support/src/organization-statement.host.e2e.test.ts`,
				name: 'central empty: an organization central forgot is set up again on its next Fleet call',
			},
			{
				file: `${root}/${relayFile}`,
				name: 'central forgot (WS7 R-notdue, R-floors): first use recovers',
			},
			{
				file: `${root}/packages/sign-in-test-support/src/organization-admin.host.e2e.test.ts`,
				name: 'R-retrysignal (forwarding): the actual transport receives the retry deadline',
			},
			{
				file: `${root}/${relayFile}`,
				name: 'R-retrysignal (relay): the actual transport receives the retry deadline',
			},
			{
				file: `${root}/packages/sign-in-test-support/src/b2e-joint-journey.host.e2e.test.ts`,
				name: 'central restarts empty (WS7 R-notdue, R-floors)',
			},
		] as const;
		const props = { root, journey, inventory: offered, selectedFiles: authJourneyFiles(journey) };
		const selected = selectAuthObservations(props);
		expect(selected).toEqual(offered.slice(0, 8));
		const execution = new RegExp(authJourneyExecutionPattern(journey, selected), 'u');
		for (const observation of selected) expect(execution.test(observation.name)).toBe(true);
		expect(execution.test(offered[8].name)).toBe(false);
		expect(() => selectAuthObservations({ ...props, selectedFiles: [storageFile] })).toThrow(
			'omitted',
		);
	},
);

it('selects every offered agent case and leaves bootstrap unselected', () => {
	const selected = selectAuthObservations({
		inventory,
		selectedFiles: ['issuer.ts', 'faults.ts'],
		journey: 'agent',
		root,
	});
	expect(selected.map((test) => test.name)).toEqual([
		'issuer > agent: allowed effect',
		'agent: rejects outcome failure',
	]);
});

it('refuses a runner that silently omits an offered fault file', () => {
	expect(() =>
		selectAuthObservations({ inventory, selectedFiles: ['issuer.ts'], journey: 'agent', root }),
	).toThrow('omitted');
});

it('refuses empty journey discovery', () => {
	expect(() =>
		selectAuthObservations({ inventory: [], selectedFiles: ['issuer.ts'], journey: 'agent', root }),
	).toThrow('empty');
});

it('accepts all matching observations in a different execution order', () => {
	expect(() =>
		requireMatchingAuthObservations({
			selected: [inventory[0], inventory[1]],
			actual: [inventory[1], inventory[0]],
			passedCount: 2,
			root,
		}),
	).not.toThrow();
});

it.each([
	{ name: 'one positive while the selected fault is skipped', actual: [inventory[0]], count: 1 },
	{ name: 'an unrelated passing bootstrap', actual: [inventory[0], inventory[2]], count: 2 },
	{
		name: 'a duplicate positive replacing the fault',
		actual: [inventory[0], inventory[0]],
		count: 2,
	},
	{
		name: 'a different file with the same case name',
		actual: [inventory[0], { ...inventory[1], file: '/proof-checkout/other.ts' }],
		count: 2,
	},
	{ name: 'incorrect aggregate count', actual: [inventory[0], inventory[1]], count: 3 },
])('refuses $name', ({ actual, count }) => {
	expect(() =>
		requireMatchingAuthObservations({
			selected: [inventory[0], inventory[1]],
			actual,
			passedCount: count,
			root,
		}),
	).toThrow('differ');
});

it('refuses an empty selection even with zero-count agreement', () => {
	expect(() =>
		requireMatchingAuthObservations({ selected: [], actual: [], passedCount: 0, root }),
	).toThrow('differ');
});

it('selects native stamp, renewal and provisioning cases without unrelated people cases', (): void => {
	const organizationInventory = [
		{
			file: `${root}/packages/sign-in-test-support/src/organization-statement.host.e2e.test.ts`,
			name: 'organization stamp: native profile',
		},
		{
			file: `${root}/packages/sign-in-test-support/src/organization-statement.host.e2e.test.ts`,
			name: 'organization renewal: due stamp',
		},
		{
			file: `${root}/packages/sign-in-test-support/src/people-organization-provisioning.host.e2e.test.ts`,
			name: 'people: refuses setup',
		},
		{ file: `${root}/people.ts`, name: 'people: unrelated invitation' },
	];
	const files = [
		'packages/sign-in-test-support/src/organization-statement.host.e2e.test.ts',
		'packages/sign-in-test-support/src/people-organization-provisioning.host.e2e.test.ts',
	];
	expect(
		selectAuthObservations({
			inventory: organizationInventory,
			selectedFiles: files,
			journey: 'organization',
			root,
		}),
	).toEqual(organizationInventory.slice(0, 3));
	expect(() =>
		selectAuthObservations({
			inventory: organizationInventory,
			selectedFiles: files.slice(0, 1),
			journey: 'organization',
			root,
		}),
	).toThrow('omitted');
});

it('requires both real storage fence cases in the offered host inventory', (): void => {
	const files = [
		'packages/sign-in-test-support/src/authorization-fence.host.e2e.test.ts',
		'packages/sign-in-test-support/src/sign-in-storage.host.e2e.test.ts',
	];
	const cases = [
		{ file: `${root}/${files[0]}`, name: 'authorization fence: real native role write' },
		{
			file: `${root}/${files[1]}`,
			name: 'sign-in storage on d1-workerd > authorization fence: real cleanup',
		},
		{
			file: `${root}/${files[1]}`,
			name: 'sign-in storage on better-sqlite3 > authorization fence: real cleanup',
		},
		{ file: `${root}/${files[0]}`, name: 'authorization backfill: a rerun adds nothing' },
		{
			file: `${root}/${files[0]}`,
			name: 'authorization backfill: wholly unfenced organizations recover on a fenced write',
		},
		{
			file: `${root}/${files[0]}`,
			name: 'drain: workerd has no scheduled handler',
		},
	];
	const props = {
		inventory: cases,
		selectedFiles: files,
		journey: 'revision-fence',
		root,
	} as const;
	expect(selectAuthObservations(props)).toEqual(cases);
	expect(selectAuthObservations({ ...props, inventory: cases.slice(0, 4) })).toEqual(
		cases.slice(0, 4),
	);
	expect(() => selectAuthObservations({ ...props, selectedFiles: files.slice(0, 1) })).toThrow(
		'omitted',
	);
});

it('keeps token, push and delivery observations in the revision journey and rejects omitted files', (): void => {
	const observations = [
		{ file: `${root}/fences.ts`, name: 'authorization fence: atomic native write' },
		{ file: `${root}/tokens.ts`, name: 'person-fleet token: release bounds' },
		{ file: `${root}/push.ts`, name: 'drain: ACK then synced' },
		{ file: `${root}/storage.ts`, name: 'storage > authorization delivery: one snapshot' },
		{ file: `${root}/storage.ts`, name: 'storage > fleet call: pending revision refuses the call' },
		{ file: `${root}/people.ts`, name: 'people: unrelated invitation' },
	];
	const props = {
		root,
		journey: 'revision-fence',
		inventory: observations,
		selectedFiles: ['fences.ts', 'tokens.ts', 'push.ts', 'storage.ts'],
	} as const;
	expect(selectAuthObservations(props)).toEqual(observations.slice(0, 5));
	expect(() =>
		selectAuthObservations({ ...props, selectedFiles: ['fences.ts', 'tokens.ts', 'storage.ts'] }),
	).toThrow('omitted');
});

it('selects renew-on-use, key-change, guarded routes and both record stores without importing the joint-central lane', (): void => {
	const files = [
		'packages/sign-in-test-support/src/organization-statement.host.e2e.test.ts',
		'packages/sign-in-test-support/src/organization-admin.host.e2e.test.ts',
		'packages/sign-in-test-support/src/fleet-admin-relay.host.e2e.test.ts',
		'packages/sign-in-test-support/src/sign-in-storage.host.e2e.test.ts',
		'packages/sign-in-test-support/src/people-organization-provisioning.host.e2e.test.ts',
	];
	const offered = [
		{ file: `${root}/${files[0]}`, name: 'renewal on use: lost reply [then retry]' },
		{ file: `${root}/${files[0]}`, name: 'key change: pending old key' },
		{
			file: `${root}/${files[1]}`,
			name: 'organization admin: over an expired stamp the call waits',
		},
		{ file: `${root}/${files[2]}`, name: 'relay: over an expired stamp the call waits' },
		{
			file: `${root}/${files[3]}`,
			name: 'sign-in storage on d1-workerd > organization stamp: one sent statement',
		},
		{
			file: `${root}/${files[3]}`,
			name: 'sign-in storage on better-sqlite3 > organization stamp: one sent statement',
		},
		{ file: `${root}/${files[4]}`, name: 'people: setup seeds central facts' },
		{ file: `${root}/${files[3]}`, name: 'storage > fleet call: one shared deadline' },
		{ file: `${root}/${files[2]}`, name: 'relay: a renewal central never answers' },
		{ file: `${root}/${files[3]}`, name: 'people: unrelated record write' },
		{
			file: `${root}/packages/sign-in-test-support/src/b2e-joint-journey.host.e2e.test.ts`,
			name: 'renewal on use: real central replaces its stamp',
		},
	];
	const selected = selectAuthObservations({
		root,
		journey: 'organization',
		inventory: offered,
		selectedFiles: files,
	});
	expect(selected).toEqual(offered.slice(0, 9));
	const execution = new RegExp(authJourneyExecutionPattern('organization', selected), 'u');
	for (const observation of selected) expect(execution.test(observation.name)).toBe(true);
	for (const observation of offered.slice(9)) expect(execution.test(observation.name)).toBe(false);
	expect(execution.test('renewal on use: lost reply t')).toBe(false);
	expect(() =>
		selectAuthObservations({
			root,
			journey: 'organization',
			inventory: offered,
			selectedFiles: files.filter((file) => !file.includes('fleet-admin-relay')),
		}),
	).toThrow('omitted');
});
