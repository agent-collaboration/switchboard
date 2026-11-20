import { authJourneyFiles } from '../../packages/sign-in-test-support/src/test-fixtures/auth-verification-journeys';
import { signInVerificationBaseline } from '../../verification/target-baseline';
import type { TestSelection } from './verification-decisions';

export const flowIds = ['passkey-sign-in', 'organizations', 'cli-sign-in', 'agents'] as const;
export type FlowId = (typeof flowIds)[number];
const source = 'packages/sign-in-test-support/src/';
const hostFile = (name: string): string => `${source}${name}.host.e2e.test.ts`;
export interface Flow {
	readonly id: FlowId;
	readonly behavior: string;
	readonly adoptedSource: string;
	readonly minimumCommit: typeof signInVerificationBaseline;
	readonly selections: (host: 'node' | 'cloudflare') => readonly TestSelection[];
}
export const flows: readonly Flow[] = [
	{
		id: 'passkey-sign-in',
		minimumCommit: signInVerificationBaseline,
		behavior:
			'User-verified passkey sign-in; failures leave no session; removed members cannot insert one.',
		adoptedSource: 'B1-B Specification S1–S12 / Verification V1–V9',
		selections: (host) => [
			{
				files: [hostFile('sign-in-native-browser')],
				pattern: `^F native Better Auth browser journey on ${host}$`,
				minimumPassed: 1,
				requiredNames: [`F native Better Auth browser journey on ${host}`],
			},
			{
				files: [hostFile('people-passkey-sign-in')],
				requiredNames: [
					'people: a user-verified sign-in is born confirmed, releases no body token, and its 15-minute window expires',
					'people: a removed member cannot sign in with their registered user-verified passkey',
					'people: an unavailable sign-in audit write refuses the confirmed session and cleans it up',
				],
			},
		],
	},
	{
		id: 'organizations',
		behavior:
			'Choose and switch organization, continue CLI sign-in, and read People without cross-organization disclosure.',
		adoptedSource: 'B1-C Specification S1–S10, S13 / Verification V1–V6',
		minimumCommit: signInVerificationBaseline,
		selections: () => [
			{
				files: [
					'people-organization-browser',
					'people-organizations',
					'people-membership-lookup',
					'people-organization-list',
					'people-organization-context',
				].map(hostFile),
				requiredNames: [
					'people: real Chrome switches twice, completes the original native CLI, and reads back lost and refused switch replies',
					'people: real Chrome keeps the latest checked lookup and list page in a read-only accessible people page',
					'people: lookup discards real held facts after the owners session is permission-lost',
					'people: people-list discards the real held member page after the owners session is permission-lost',
					'people: self-context needs no old second-factor confirmation and never refreshes it or the session',
					'people: member permissions, owner removal and unoffered routes refuse without changing authority',
				],
			},
		],
	},
	{
		id: 'cli-sign-in',
		minimumCommit: signInVerificationBaseline,
		behavior:
			'Native owner authorization completes through the delivered CLI; stable click and keyboard activation work.',
		adoptedSource: 'packages/sign-in-owner-cli/README.md#fleet-commands; B1-B S10 / V8',
		selections: (host) => [
			{
				files: [hostFile('sign-in-native-browser')],
				pattern: `^F native Better Auth browser journey on ${host}$`,
				requiredNames: [`F native Better Auth browser journey on ${host}`],
			},
			{
				files: ['native-cli-keyboard-activation', 'native-browser-click'].map(hostFile),
				requiredNames: [
					'rejects a stale click point when a late layout shift moves the selected control',
					'dispatches real native input to a stable selected control',
					'activates the same Continue button after a lower sibling moves it between measurement and native input',
				],
			},
			{
				files: authJourneyFiles('bootstrap'),
				pattern: 'bootstrap:',
				requiredNames: [
					"bootstrap: refuses 'a verified non-owner' first arrival before admitting the configured owner",
					"bootstrap: refuses 'an unverified configured owner' first arrival before admitting the configured owner",
					'S1 real agent issuer through the Gateway bootstrap: native S256 loopback creates the fixed owner client once with real owner cookie and audit',
				],
			},
		],
	},
	{
		id: 'agents',
		minimumCommit: signInVerificationBaseline,
		behavior:
			'An owner registers an agent and its workspace-bound credentials authorize only the intended workspace.',
		adoptedSource: 'B1-A S11 / V10',
		selections: () => [
			{
				files: authJourneyFiles('agent'),
				pattern: 'agent:',
				requiredNames: [
					'S1 real agent issuer through the Gateway agent: real HTTP registration, token and JWKS authorize exactly one O1 effect and zero O2 effects',
					'agent: delivered owner CLI registers, links, removes one workspace and retires without printing a credential',
					'agent: a real O2 W3 token dispatches exactly once under W3 credentials and never at W1 or W2',
				],
			},
		],
	},
];
