import type { GenericEndpointContext } from '@better-auth/core';
import { APIError, getSessionFromCtx } from 'better-auth/api';

import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import type { SignInClock, Uuid7 } from '#sign-in-core/contracts/sign-in-platform';
import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import type {
	FactorSessionState,
	SecondFactorRecords,
} from '#sign-in-core/second-factors/second-factor-session';
import {
	decideFactorChange,
	decideRecentSecondFactor,
	type FactorChange,
} from '#sign-in-core/second-factors/second-factor-step-up';
import { personIdSchema, type PersonId } from '#sign-in-core/storage/models/sign-in-store';

export interface FactorActor {
	readonly personId: PersonId;
	readonly sessionId: Uuid7;
	readonly factors: FactorSessionState;
}
export async function requireFactorActor(props: {
	readonly context: GenericEndpointContext;
	readonly store: Pick<SecondFactorRecords, 'readSession'>;
}): Promise<FactorActor> {
	const current = await getSessionFromCtx(props.context, {
		disableCookieCache: true,
		disableRefresh: true,
	});
	if (current === null || !current.user.emailVerified) throw new APIError('UNAUTHORIZED');
	const personId = personIdSchema.parse(current.user.id);
	const sessionId = uuid7Schema.parse(current.session.id);
	const factors = requireStoredValue(await props.store.readSession(personId, sessionId));
	if (factors === null) throw new APIError('UNAUTHORIZED');
	return { personId, sessionId, factors };
}
export function requireRecentFactor(props: {
	readonly clock: SignInClock;
	readonly factors: FactorSessionState;
}): void {
	if (
		decideRecentSecondFactor({ now: props.clock.now(), confirmation: props.factors.confirmation })
			.kind !== 'confirmed'
	)
		throw new APIError('FORBIDDEN', {
			code: 'SECOND_FACTOR_REQUIRED',
			message: 'secondFactorRequired',
		});
}
export function requireFactorChange(props: {
	readonly clock: SignInClock;
	readonly factors: FactorSessionState;
	readonly change: FactorChange;
}): void {
	const decision = decideFactorChange({
		now: props.clock.now(),
		enrollment: props.factors.enrollment,
		confirmation: props.factors.confirmation,
		change: props.change,
	});
	if (decision.kind === 'app-required')
		throw new APIError('FORBIDDEN', { code: 'APP_REQUIRED', message: 'appRequired' });
	if (decision.kind === 'second-factor-required')
		throw new APIError('FORBIDDEN', {
			code: 'SECOND_FACTOR_REQUIRED',
			message: 'secondFactorRequired',
		});
}
