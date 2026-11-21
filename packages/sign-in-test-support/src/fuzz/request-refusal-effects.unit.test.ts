import { expect, it } from 'vitest';

import { assertRequestRefusalEffects } from '#sign-in-test-support/fuzz/request-refusal-effects';
import type { RequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import type { RouteClassification } from '#sign-in-test-support/fuzz/route-classification';

type EffectsFixture = Parameters<typeof assertRequestRefusalEffects>[0]['fixture'];
const personId = '019a3dce-2000-7000-8000-000000000001';
const sessionId = '019a3dce-2000-7000-8000-000000000002';
const challengeId = '019a3dce-2000-7000-8000-000000000003';
const passkeyId = '019a3dce-2000-7000-8000-000000000004';
const fixture: EffectsFixture = { sessionId, context: { personId, challengeId, passkeyId } };
const classification: RouteClassification = {
	method: 'POST',
	path: '/api/auth/passkey/confirm',
	exposure: ['owner'],
	requestParts: ['json'],
	documentedAnswers: [403],
	disclosure: 'caller only',
	permittedRefusalEffects: ['consume-passkey-challenge', 'factor-intent'],
	evidence: 'test fixture',
};
const challenge = {
	identifier: `passkey-confirm:${sessionId}:${challengeId}`,
	value: 'challenge-value',
};
const unrelated = { identifier: 'other-verification', value: 'other-value' };
const before: RequestStorageSnapshot = {
	verification: [challenge, unrelated],
	user: [{ id: personId, name: 'Original' }],
	signInAudit: [],
};
function check(after: RequestStorageSnapshot): void {
	assertRequestRefusalEffects({ classification, fixture, before, after });
}

it('allows only consumption of the exact passkey challenge', (): void => {
	expect(() => check({ ...before, verification: [unrelated] })).not.toThrow();
	expect(() => check({ ...before, verification: [challenge] })).toThrow('verification');
	expect(() =>
		check({ ...before, verification: [unrelated, { identifier: 'new', value: 'new' }] }),
	).toThrow('verification');
	expect(() =>
		check({ ...before, verification: [unrelated], user: [{ id: personId, name: 'Changed' }] }),
	).toThrow('user');
});

it('permits only the exact factor intent and rejects another actor, action, target, phase or added row', (): void => {
	const intent = {
		kind: 'second-factor-changed',
		actor_user_id: personId,
		phase: 'intent',
		change_kind: 'passkey-confirmed',
		target_id: passkeyId,
	};
	expect(() => check({ ...before, signInAudit: [intent] })).not.toThrow();
	for (const invalid of [
		{ ...intent, actor_user_id: 'other' },
		{ ...intent, change_kind: 'passkey-removed' },
		{ ...intent, target_id: personId },
		{ ...intent, target_id: 'other' },
		{ ...intent, phase: 'outcome' },
	])
		expect(() => check({ ...before, signInAudit: [invalid] })).toThrow('signInAudit');
	expect(() =>
		check({ ...before, signInAudit: [intent, { ...intent, target_id: 'other' }] }),
	).toThrow('signInAudit');
});
