import path from 'node:path';

import { z } from 'zod';

import type { AuthHarnessRequestLimits } from '#sign-in-test-support/test-fixtures/proof-bundle-artifacts';

export const revisionFencePattern =
	'authorization (?:fence|backfill|delivery):|person-fleet token:|drain:|fleet call:|central (?:empty:|forgot(?::| \\(WS7))|R-retrysignal \\((?:relay|forwarding)\\):';
const revisionFenceNames = new RegExp(revisionFencePattern, 'u');
const organizationObservationNames =
	/organization (?:stamp|renewal):|renewal on use:|key change:|fleet call:|drain:|central (?:empty:|forgot(?::| \(WS7))|R-retrysignal \((?:relay|forwarding)\):|(?:organization admin|relay): over an expired stamp|relay: a renewal central never answers/u;
// The real-central joint lane has its own artifact pin and receipts; this journey uses the recording peer.
const jointCentralCaseFile = 'packages/sign-in-test-support/src/b2e-joint-journey.host.e2e.test.ts';

/** The local journeys, selecting permanent host cases by their declared prefixes and source files. */
export const authJourneySchema = z.enum([
	'agent',
	'bootstrap',
	'people',
	'organization',
	'revision-fence',
]);
export type AuthJourney = z.infer<typeof authJourneySchema>;

/** The harness readiness witnesses each journey counts. People cases sign in through the provider callback, so only they
 * accept a stored sign-in session; bootstrap and agent keep their public-JWKS or native-CLI login witness. */
export const journeyReadinessEvents = {
	agent: ['jwks', 'personToken'],
	bootstrap: ['jwks', 'personToken'],
	people: ['jwks', 'personToken', 'signInSession'],
	organization: ['jwks', 'personToken', 'signInSession'],
	'revision-fence': ['jwks', 'personToken', 'signInSession'],
} as const satisfies Record<AuthJourney, readonly [string, ...string[]]>;

export interface OfferedAuthTest {
	readonly name: string;
	readonly file: string;
}

/** Exactly one people harness per host arms a real backing-limiter failure (the Node counter throws, or the Cloudflare
 * binding rejects) to prove the 503 fail-closed path; no other journey arms one. */
export const admittedBackingFailureReceipts: Readonly<Record<AuthJourney, number>> = {
	agent: 0,
	bootstrap: 0,
	people: 1,
	organization: 0,
	'revision-fence': 0,
};

/** Exactly one service-page and one passkey workerd budget case use named clocked stand-ins. */
export function requireAdmittedRequestLimitCounters(props: {
	readonly journey: AuthJourney;
	readonly signInHost: 'workerd' | 'node';
	readonly requestLimits: readonly AuthHarnessRequestLimits[];
}): void {
	const realCounter = props.signInHost === 'node' ? 'node-fixed-window' : 'cloudflare-real-binding';
	const hostBackingFailure =
		props.signInHost === 'node' ? 'node-counter-throws' : 'cloudflare-binding-rejects';
	const standIns = props.requestLimits.filter(
		(limits) => limits.outerCounter === 'cloudflare-controlled-binding-stand-in',
	);
	const expectedPerCase = props.journey === 'people' && props.signInHost === 'workerd' ? 1 : 0;
	const armedFailures = props.requestLimits.filter((limits) => limits.backingFailure !== 'none');
	if (
		standIns.length !== expectedPerCase * 2 ||
		standIns.filter((limits) => limits.proofCase === 'service-page-exact-budget').length !==
			expectedPerCase ||
		standIns.filter((limits) => limits.proofCase === 'passkey-exact-budget').length !==
			expectedPerCase ||
		standIns.some((limits) => limits.backingFailure !== 'none') ||
		armedFailures.length !== admittedBackingFailureReceipts[props.journey] ||
		armedFailures.some((limits) => limits.backingFailure !== hostBackingFailure) ||
		props.requestLimits.some(
			(limits) =>
				limits.outerCounter !== realCounter &&
				limits.outerCounter !== 'cloudflare-controlled-binding-stand-in',
		)
	)
		throw new Error('Harness request counters differ from the admitted journey counters');
}

/** Workerd-only callers; Node startup backfill and no-interval wiring are checked separately. */
export const workerdOnlyCallerCases = [
	'authorization backfill: the workerd deploy step is a server-only management method and idempotent',
	'drain: workerd has no scheduled handler, so no cron can run a drain, backfill or renewal (owner, 12 Nov)',
] as const;

export function selectAuthObservations(props: {
	readonly inventory: readonly OfferedAuthTest[];
	readonly selectedFiles: readonly string[];
	readonly journey: AuthJourney;
	readonly root: string;
}): readonly OfferedAuthTest[] {
	const offered = props.inventory.filter((test) =>
		props.journey === 'organization'
			? (path.relative(props.root, test.file) !== jointCentralCaseFile &&
					organizationObservationNames.test(test.name)) ||
				(path.relative(props.root, test.file) ===
					'packages/sign-in-test-support/src/people-organization-provisioning.host.e2e.test.ts' &&
					test.name.includes('people:'))
			: props.journey === 'revision-fence'
				? revisionFenceNames.test(test.name)
				: test.name.includes(`${props.journey}:`),
	);
	if (
		offered.length === 0 ||
		offered.some((test) => !props.selectedFiles.includes(path.relative(props.root, test.file)))
	)
		throw new Error('Offered journey inventory is empty or omitted by the runner');
	return offered;
}

/** The same selected titles drive execution. A broad people: pattern would also
 * execute unrelated storage cases once the organization journey includes that file. */
export function authJourneyExecutionPattern(
	journey: AuthJourney,
	selected: readonly OfferedAuthTest[],
): string {
	if (journey !== 'organization')
		return journey === 'revision-fence' ? revisionFencePattern : `${journey}:`;
	return [...new Set(selected.map((test) => test.name.split(' > ').at(-1) ?? test.name))]
		.map((title) => `${title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`)
		.join('|');
}

export function requireMatchingAuthObservations(props: {
	readonly selected: readonly OfferedAuthTest[];
	readonly actual: readonly OfferedAuthTest[];
	readonly passedCount: number;
	readonly root: string;
}): void {
	function names(tests: readonly OfferedAuthTest[]): readonly string[] {
		return tests.map((test) => `${path.relative(props.root, test.file)}:${test.name}`).toSorted();
	}
	if (
		props.selected.length === 0 ||
		props.passedCount !== props.selected.length ||
		JSON.stringify(names(props.selected)) !== JSON.stringify(names(props.actual))
	)
		throw new Error('Executed observations differ from offered selection');
}

export function authJourneyFiles(journey: AuthJourney): readonly string[] {
	const testSource = 'packages/sign-in-test-support/src';
	if (journey === 'revision-fence')
		return [
			`${testSource}/authorization-fence.host.e2e.test.ts`,
			`${testSource}/organization-statement.host.e2e.test.ts`,
			`${testSource}/organization-admin.host.e2e.test.ts`,
			`${testSource}/person-fleet-token.host.e2e.test.ts`,
			`${testSource}/authorization-revision-drain.host.e2e.test.ts`,
			`${testSource}/fleet-admin-relay.host.e2e.test.ts`,
			`${testSource}/sign-in-storage.host.e2e.test.ts`,
		];
	if (journey === 'organization')
		return [
			`${testSource}/organization-statement.host.e2e.test.ts`,
			`${testSource}/people-organization-provisioning.host.e2e.test.ts`,
			`${testSource}/organization-admin.host.e2e.test.ts`,
			`${testSource}/fleet-admin-relay.host.e2e.test.ts`,
			`${testSource}/authorization-revision-drain.host.e2e.test.ts`,
			`${testSource}/sign-in-storage.host.e2e.test.ts`,
		];
	if (journey === 'people')
		return [
			`${testSource}/organization-upgrade.host.e2e.test.ts`,
			`${testSource}/people-factor-enrollment.host.e2e.test.ts`,
			`${testSource}/people-passkey-confirmation.host.e2e.test.ts`,
			`${testSource}/people-passkey-sign-in.host.e2e.test.ts`,
			`${testSource}/people-passkey-page.host.e2e.test.ts`,
			`${testSource}/people-organizations.host.e2e.test.ts`,
			`${testSource}/people-organization-provisioning.host.e2e.test.ts`,
			`${testSource}/people-owner-page.host.e2e.test.ts`,
			`${testSource}/people-organization-context.host.e2e.test.ts`,
			`${testSource}/people-membership-lookup.host.e2e.test.ts`,
			`${testSource}/people-organization-list.host.e2e.test.ts`,
			`${testSource}/people-organization-browser.host.e2e.test.ts`,
			`${testSource}/people-record-faults.host.e2e.test.ts`,
			`${testSource}/people-request-limits.host.e2e.test.ts`,
			`${testSource}/sign-in-storage.host.e2e.test.ts`,
		];
	return [
		'packages/sign-in-test-support/src/agent-issuer.host.e2e.test.ts',
		...(journey === 'agent'
			? [
					'packages/sign-in-test-support/src/agent-registration-faults.host.e2e.test.ts',
					'packages/sign-in-test-support/src/management-boundaries.host.e2e.test.ts',
					'packages/sign-in-test-support/src/agent-token-races.host.e2e.test.ts',
					'packages/sign-in-test-support/src/person-live-management.host.e2e.test.ts',
					'packages/sign-in-test-support/src/owner-authority-boundaries.host.e2e.test.ts',
					'packages/sign-in-test-support/src/native-code-protocol.host.e2e.test.ts',
					'packages/sign-in-test-support/src/workspace-agent-issuance.host.e2e.test.ts',
					'packages/sign-in-test-support/src/workspace-management-boundaries.host.e2e.test.ts',
					'packages/sign-in-test-support/src/workspace-management-audit-faults.host.e2e.test.ts',
					'packages/sign-in-test-support/src/workspace-person-boundary.host.e2e.test.ts',
					'packages/sign-in-test-support/src/workspace-retirement-overlap.host.e2e.test.ts',
					'packages/sign-in-test-support/src/workspace-owner-cli.host.e2e.test.ts',
				]
			: []),
	];
}

/** Accepted slice-3 composition: isolated deadlines use pure vectors, then the real outer fence. */
export const revisionFenceSupportingUnitFiles = [
	'packages/sign-in-core/src/better-auth/person-fleet-token-claims.unit.test.ts',
	'packages/sign-in-core/src/organizations/person-fleet-issuance.unit.test.ts',
	'packages/sign-in-core/src/response-release/person-fleet-release.unit.test.ts',
	'packages/sign-in-test-support/src/core-tests/sign-in-response-release.unit.test.ts',
] as const;
