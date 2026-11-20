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
			},
			{ files: [hostFile('people-passkey-sign-in')] },
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
			},
		],
	},
	{
		id: 'cli-sign-in',
		minimumCommit: signInVerificationBaseline,
		behavior:
			'Native owner authorization completes through the delivered CLI; stable click and keyboard activation work.',
		adoptedSource: 'packages/sign-in-owner-cli/README.md#fleet-commands; B1-B S10 / V8',
		selections: () => [
			{ files: ['native-cli-keyboard-activation', 'native-browser-click'].map(hostFile) },
			{ files: authJourneyFiles('bootstrap'), pattern: 'bootstrap:' },
		],
	},
	{
		id: 'agents',
		minimumCommit: signInVerificationBaseline,
		behavior:
			'An owner registers an agent and its workspace-bound credentials authorize only the intended workspace.',
		adoptedSource: 'B1-A S11 / V10',
		selections: () => [{ files: authJourneyFiles('agent'), pattern: 'agent:' }],
	},
];
