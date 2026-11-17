import { describe, expect, it } from 'vitest';

import { epochMillisecondsSchema } from '#sign-in-core/contracts/sign-in-platform';
import {
	factorSessionState,
	storedFactorSessionSchema,
} from '#sign-in-core/second-factors/second-factor-session';
import {
	decideFactorChange,
	decideRecentSecondFactor,
	type SecondFactorConfirmation,
} from '#sign-in-core/second-factors/second-factor-step-up';

const confirmedAt = epochMillisecondsSchema.parse(2_208_988_800_000);
const confirmation: SecondFactorConfirmation = {
	kind: 'confirmed',
	at: confirmedAt,
	method: 'app',
};

describe('the same 15-minute second-factor rule for people and factor changes', () => {
	it.each([
		{ elapsed: 0, expected: 'confirmed' },
		{ elapsed: 899_999, expected: 'confirmed' },
		{ elapsed: 900_000, expected: 'confirmed' },
		{ elapsed: 900_001, expected: 'second-factor-required' },
		{ elapsed: 960_000, expected: 'second-factor-required' },
	])('at T+$elapsed ms returns $expected', ({ elapsed, expected }) => {
		// The oracle is PD R53 / C13: exactly fifteen minutes is included.
		expect(
			decideRecentSecondFactor({
				now: epochMillisecondsSchema.parse(confirmedAt + elapsed),
				confirmation,
			}).kind,
		).toBe(expected);
	});
	it('requires a confirmation when the session has none', () => {
		expect(
			decideRecentSecondFactor({ now: confirmedAt, confirmation: { kind: 'unconfirmed' } }),
		).toEqual({ kind: 'second-factor-required', withinSeconds: 900 });
	});
	it('permits the first app setup from a provider session, while refusing a passkey as the first factor', () => {
		const request = {
			now: confirmedAt,
			enrollment: { kind: 'never-enrolled' } as const,
			confirmation: { kind: 'unconfirmed' } as const,
		};
		expect(decideFactorChange({ ...request, change: 'begin-app-enrollment' })).toEqual({
			kind: 'allowed',
		});
		expect(decideFactorChange({ ...request, change: 'add-passkey' })).toEqual({
			kind: 'app-required',
		});
	});
	it.each([
		'begin-app-enrollment',
		'add-passkey',
		'rename-passkey',
		'remove-passkey',
		'remove-app',
		'rotate-recovery-codes',
	] as const)('provider sign-in alone never authorizes %s after the first enrollment', (change) => {
		expect(
			decideFactorChange({
				now: confirmedAt,
				enrollment: { kind: 'enrolled', setAt: confirmedAt },
				confirmation: { kind: 'unconfirmed' },
				change,
			}),
		).toEqual({ kind: 'second-factor-required', withinSeconds: 900 });
	});
	it('uses the confirmation on the supplied session rather than the age of first enrollment', () => {
		expect(
			decideFactorChange({
				now: epochMillisecondsSchema.parse(confirmedAt + 900_000),
				enrollment: { kind: 'enrolled', setAt: epochMillisecondsSchema.parse(0) },
				confirmation,
				change: 'remove-app',
			}),
		).toEqual({ kind: 'allowed' });
	});
});

it.each([
	{ name: 'enabled native two-factor', enabled: true, app: 0, key: 0 },
	{ name: 'verified native app', enabled: false, app: 1, key: 0 },
	{ name: 'existing native passkey', enabled: false, app: 0, key: 1 },
] as const)(
	'a missing recorded stamp never grants the first-setup exception with $name',
	({ enabled, app, key }) => {
		const factors = factorSessionState(
			storedFactorSessionSchema.parse({
				secondFactorAt: null,
				secondFactorMethod: null,
				secondFactorSetAt: null,
				twoFactorEnabled: enabled,
				hasVerifiedApp: app,
				hasPasskey: key,
			}),
		);
		expect(factors.enrollment).toEqual({ kind: 'enrolled', setAt: null });
		expect(
			decideFactorChange({ now: confirmedAt, ...factors, change: 'begin-app-enrollment' }),
		).toEqual({ kind: 'second-factor-required', withinSeconds: 900 });
		expect(decideFactorChange({ now: confirmedAt, ...factors, change: 'add-passkey' })).toEqual({
			kind: 'second-factor-required',
			withinSeconds: 900,
		});
	},
);
it('permits first app setup only with no recorded time and no working native factor', () => {
	const factors = factorSessionState(
		storedFactorSessionSchema.parse({
			secondFactorAt: null,
			secondFactorMethod: null,
			secondFactorSetAt: null,
			twoFactorEnabled: false,
			hasVerifiedApp: 0,
			hasPasskey: 0,
		}),
	);
	expect(factors.enrollment).toEqual({ kind: 'never-enrolled' });
	expect(
		decideFactorChange({ now: confirmedAt, ...factors, change: 'begin-app-enrollment' }),
	).toEqual({ kind: 'allowed' });
});
