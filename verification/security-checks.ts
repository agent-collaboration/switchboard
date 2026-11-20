import { z } from 'zod';

import qualifiedPatches from './qualified-edits.json';
import { signInVerificationBaseline } from './target-baseline';

export const securityEditSchema = z.strictObject({
	kind: z.literal('text'),
	file: z.string(),
	find: z.string().min(1),
	replace: z.string(),
});
export type SecurityEdit = z.infer<typeof securityEditSchema>;
export interface SecurityCheck {
	readonly id: string;
	readonly minimumCommit: typeof signInVerificationBaseline;
	readonly edits: readonly SecurityEdit[];
	readonly testFiles: readonly string[];
	readonly testNames: readonly string[];
	readonly expectedFailure: string;
	readonly expectedFailures: number;
	readonly project: 'unit' | 'e2e-host';
	readonly adoptedSource: string;
	readonly editSource: string;
}
const patchSchema = z.object({
	source: z.string(),
	edits: z.array(z.object({ file: z.string(), find: z.string(), replace: z.string() })),
});
const patches = z.array(patchSchema).parse(qualifiedPatches);
const core = 'packages/sign-in-core/src/';
const support = 'packages/sign-in-test-support/src/';
const hostFile = (name: string): string => `${support}${name}.host.e2e.test.ts`;
function fromPatch(source: string): readonly SecurityEdit[] {
	const patch = patches.find((candidate) => candidate.source === source);
	if (patch === undefined) throw new Error(`Missing qualified edit: ${source}`);
	return patch.edits.map((edit) => ({ kind: 'text', ...edit }));
}
const lookupList = [hostFile('people-membership-lookup'), hostFile('people-organization-list')];
const memberList =
	'people: owner people-list returns exactly 51 own-organization members over two ordered pages and only pending unexpired nonmember invitations';
function httpCheck(props: {
	readonly id: string;
	readonly patch: string;
	readonly names: readonly string[];
	readonly files: readonly string[];
	readonly failure: string;
}): SecurityCheck {
	return {
		id: props.id,
		minimumCommit: signInVerificationBaseline,
		edits: fromPatch(props.patch),
		testFiles: props.files,
		testNames: props.names,
		expectedFailure: props.failure,
		expectedFailures: props.names.length,
		project: 'e2e-host',
		adoptedSource:
			'B1-C specification checked membership reads; verification-design HTTP checks9–16',
		editSource: `Qualified Sunclaw HTTP9–16/B04 packet: ${props.patch}`,
	};
}
/** Exact edits adopted from qualified B1-B review packet and B1-C HTTP9–16/B04 packets. */
export const securityChecks: readonly SecurityCheck[] = [
	{
		id: 'V5',
		minimumCommit: signInVerificationBaseline,
		edits: [
			{
				kind: 'text',
				file: `${core}better-auth/provider-configuration.ts`,
				find: 'if (!(await persons.ensurePersonActive(session.userId)))',
				replace: 'if (false)',
			},
		],
		testFiles: [hostFile('people-passkey-sign-in')],
		testNames: [
			'people: a removed member cannot sign in with their registered user-verified passkey',
		],
		expectedFailure: 'to deeply equal',
		expectedFailures: 1,
		project: 'e2e-host',
		adoptedSource: 'B1-B specification S5 / verification V5',
		editSource: 'Qualified ab1ccef review packet step2; INSERT marker equality',
	},
	{
		id: 'F1',
		minimumCommit: signInVerificationBaseline,
		edits: fromPatch('B2-b1b-f1-omit-catch-audit.patch'),
		testFiles: [hostFile('people-passkey-sign-in')],
		testNames: ['people: a release cleanup failure with writable audit storage stays cookie-free'],
		expectedFailure: 'expected [] to deeply equal',
		expectedFailures: 1,
		project: 'e2e-host',
		adoptedSource: 'B1-B specification S12; adopted PR8 review F1',
		editSource: 'Qualified merged-head B2 control b1b-f1-omit-catch-audit.patch; catch write only',
	},
	{
		id: 'V6-provider',
		minimumCommit: signInVerificationBaseline,
		edits: [
			{
				kind: 'text',
				file: `${core}request-limits/request-limit-policy.ts`,
				find: "'callback-passkey': {\n\t\tbinding: 'SIGN_IN_ATTEMPTS',\n\t\touter: signInAttemptsLimit,\n\t\tprovider: { max: 10, windowSeconds: 60 },",
				replace:
					"'callback-passkey': {\n\t\tbinding: 'SIGN_IN_ATTEMPTS',\n\t\touter: signInAttemptsLimit,\n\t\tprovider: { max: 1000, windowSeconds: 60 },",
			},
		],
		testFiles: [hostFile('people-request-limits')],
		testNames: [
			'people: the native passkey provider challenge budget refuses independently of the outer budget',
			'people: the native passkey provider verify budget refuses independently of the outer budget',
		],
		expectedFailure: 'expected 200 to be 429',
		expectedFailures: 2,
		project: 'e2e-host',
		adoptedSource: 'B1-B specification S8 / V6, adopted per-layer correction',
		editSource: 'Qualified ab1ccef review packet step3 provider-only',
	},
	{
		id: 'V6-outer',
		minimumCommit: signInVerificationBaseline,
		edits: [
			{
				kind: 'text',
				file: `${core}request-limits/sign-in-request-admission.ts`,
				find: 'decision = await props.platform.requestLimiter.allow({ requestClass, address });',
				replace:
					"decision = requestClass === 'callback-passkey' ? { kind: 'allowed' } : await props.platform.requestLimiter.allow({ requestClass, address });",
			},
		],
		testFiles: [hostFile('people-request-limits')],
		testNames: [
			'people: the outer passkey budget refuses challenge GET and verify POST before challenge or session effects',
		],
		expectedFailure: 'expected 200 to be 429',
		expectedFailures: 1,
		project: 'e2e-host',
		adoptedSource: 'B1-B S8 / V6, controlled exact window plus separate real-binding wiring',
		editSource: 'Qualified ab1ccef review packet step3 outer-only',
	},
	{
		id: 'B04',
		minimumCommit: signInVerificationBaseline,
		edits: fromPatch('B04-stamp-confirmation-on-switch.patch'),
		testFiles: [hostFile('people-organization-browser')],
		testNames: [
			'people: real Chrome switches twice, completes the original native CLI, and reads back lost and refused switch replies',
		],
		expectedFailure: 'to deeply equal',
		expectedFailures: 1,
		project: 'e2e-host',
		adoptedSource: 'B1-C organization switch preserves second-factor facts / B04',
		editSource: 'Qualified Sunclaw B04-stamp-confirmation-on-switch.patch',
	},
	httpCheck({
		id: 'HTTP09',
		patch: '09-v4-v5-skip-first-check.patch',
		files: lookupList,
		names: [
			'people: lookup refuses member before a facts query and releases no subject fields',
			'people: people-list refuses member before the member page query with no listed fields',
		],
		failure: 'expected 1 to be +0',
	}),
	httpCheck({
		id: 'HTTP10',
		patch: '10-v4-v5-skip-second-check.patch',
		files: lookupList,
		names: [
			'people: lookup discards real held facts after the owners session is ended',
			'people: people-list discards the real held member page after the owners session is ended',
		],
		failure: 'expected 200 to be 401',
	}),
	httpCheck({
		id: 'HTTP11',
		patch: '11-v4-v5-second-check-cached-session.patch',
		files: lookupList,
		names: [
			'people: lookup discards real held facts after the owners session is ended',
			'people: people-list discards the real held member page after the owners session is ended',
		],
		failure: 'expected 200 to be 401',
	}),
	httpCheck({
		id: 'HTTP12',
		patch: '12-v4-facts-error-becomes-not-member.patch',
		files: [lookupList[0] ?? ''],
		names: [
			'people: lookup reports unavailable after a real facts select fault and writes nothing',
		],
		failure: 'expected 200 to be 503',
	}),
	httpCheck({
		id: 'HTTP13',
		patch: '13-v5-member-page-without-org.patch',
		files: [lookupList[1] ?? ''],
		names: [memberList],
		failure: 'to deeply equal',
	}),
	httpCheck({
		id: 'HTTP14',
		patch: '14-v5-list-sql-pending-only.patch',
		files: [lookupList[1] ?? ''],
		names: [
			'people: people-list reports unavailable for malformed stored invitation-status rather than a shortened list',
		],
		failure: 'expected 200 to be 503',
	}),
	httpCheck({
		id: 'HTTP15',
		patch: '15-v5-native-member-object-released.patch',
		files: [lookupList[1] ?? ''],
		names: [memberList],
		failure: 'to deeply equal',
	}),
	httpCheck({
		id: 'HTTP16',
		patch: '16-v5-open-native-list-members.patch',
		files: [lookupList[1] ?? ''],
		names: [
			'people: native organization reads stay 404 for an owner and a member while all stored rows remain unchanged',
		],
		failure: 'expected 200 to be 404',
	}),
	{
		id: 'stale-reply',
		minimumCommit: signInVerificationBaseline,
		edits: [
			{
				kind: 'text',
				file: `${core}pages/islands/request-lifecycle-transitions.ts`,
				find: "case 'reply':\n\t\t\t\tif (state.kind !== 'pending' || event.generation !== state.generation)",
				replace: "case 'reply':\n\t\t\t\tif (state.kind !== 'pending')",
			},
		],
		testFiles: [`${core}pages/islands/request-lifecycle-transitions.unit.test.ts`],
		testNames: ['refuses a duplicate submit and stale replies after an edit and a newer submit'],
		expectedFailure: 'to deeply equal',
		expectedFailures: 1,
		project: 'unit',
		adoptedSource: 'B1-C V6 stale reply generation guard',
		editSource: 'Qualified B06-generation-only.patch, with existing direct lifecycle assertion',
	},
];

/** Literal assertion sites from the qualified permanent tests; a different assertion is not a valid red. */
export const securityAssertions: Readonly<
	Record<string, { readonly file: string; readonly marker: string; readonly assertion: string }>
> = {
	V5: {
		file: 'packages/sign-in-test-support/src/people-passkey-sign-in.host.e2e.test.ts',
		marker: 'expect(await harness.lastSessionInsert()).toEqual(lastInsert);',
		assertion: 'expect(',
	},
	F1: {
		file: 'packages/sign-in-test-support/src/people-passkey-sign-in.host.e2e.test.ts',
		marker: 'expect(await audit(harness)).toEqual(\n\t\t\t\tauditStorage',
		assertion: 'expect(',
	},
	'V6-provider': {
		file: 'packages/sign-in-test-support/src/people-request-limits.host.e2e.test.ts',
		marker: 'expect((await providerAttempt(true)).status).toBe(429);',
		assertion: 'expect(',
	},
	'V6-outer': {
		file: 'packages/sign-in-test-support/src/people-request-limits.host.e2e.test.ts',
		marker: 'expect(verify.status).toBe(429);',
		assertion: 'expect(',
	},
	B04: {
		file: 'packages/sign-in-test-support/src/test-fixtures/organization-browser-chooser.ts',
		marker: 'expect({ at: after.secondFactorAt, method: after.secondFactorMethod }).toEqual({',
		assertion: 'expect(',
	},
	HTTP09: {
		file: 'packages/sign-in-test-support/src/test-fixtures/organization-read-scenario.ts',
		marker: 'expect((await organizationReadCounts(harness))[props.kind]).toBe(counts[props.kind]);',
		assertion: 'expect(',
	},
	HTTP10: {
		file: 'packages/sign-in-test-support/src/test-fixtures/organization-read-scenario.ts',
		marker:
			"expect(response.status).toBe(revocation === 'ended' || revocation === 'expired' ? 401 : 403);",
		assertion: 'expect(',
	},
	HTTP11: {
		file: 'packages/sign-in-test-support/src/test-fixtures/organization-read-scenario.ts',
		marker:
			"expect(response.status).toBe(revocation === 'ended' || revocation === 'expired' ? 401 : 403);",
		assertion: 'expect(',
	},
	HTTP12: {
		file: 'packages/sign-in-test-support/src/people-membership-lookup.host.e2e.test.ts',
		marker: "email: 'absent@example.invalid',\n\t\t\t});\n\t\t\texpect(response.status).toBe(503);",
		assertion: 'expect(',
	},
	HTTP13: {
		file: 'packages/sign-in-test-support/src/test-fixtures/organization-read-scenario.ts',
		marker: 'expect(JSON.parse(body)).toEqual(props.body);',
		assertion: 'expect(',
	},
	HTTP14: {
		file: 'packages/sign-in-test-support/src/test-fixtures/organization-read-scenario.ts',
		marker: 'expect(response.status).toBe(props.status);',
		assertion: 'expect(',
	},
	HTTP15: {
		file: 'packages/sign-in-test-support/src/test-fixtures/organization-read-scenario.ts',
		marker: 'expect(JSON.parse(body)).toEqual(props.body);',
		assertion: 'expect(',
	},
	HTTP16: {
		file: 'packages/sign-in-test-support/src/people-organization-list.host.e2e.test.ts',
		marker: 'expect(response.status).toBe(404);',
		assertion: 'expect(',
	},
	'stale-reply': {
		file: 'packages/sign-in-core/src/pages/islands/request-lifecycle-transitions.unit.test.ts',
		marker: '\texpect(\n\t\tlifecycle.transition(\n\t\t\tnewer,',
		assertion: 'expect(',
	},
};
