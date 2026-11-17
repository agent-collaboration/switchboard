import {
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
	type OAuthBrowserSessionIdentity,
} from '@agent-collaboration/oauth-broker-contracts';
import { expect } from 'vitest';
import { z } from 'zod';

import {
	createOAuthTransactionStore,
	type OAuthCeremonyTransaction,
	type OAuthCompletionSession,
	type OAuthTransactionStore,
} from './oauth-transaction-store.js';

export const syntheticGrantSchema = z.object({ receipt: z.string().min(1) }).strict();
type SyntheticGrant = z.infer<typeof syntheticGrantSchema>;
type AuthorizingTransaction = Extract<
	OAuthCeremonyTransaction,
	{ readonly kind: 'authorizing-application' }
>;

export const modelPrincipal = {
	issuer: 'https://identity.example.test',
	subject: 'synthetic-owner',
};
export const applicationId = oauthApplicationIdSchema.parse('gmail-app');

export interface ModelTransaction {
	readonly handle: OAuthCeremonyTransaction;
	readonly expiresAtMs: number;
	readonly ownerInitiated: boolean;
	identity?: OAuthBrowserSessionIdentity;
	phase: 'selecting-permissions' | 'authorizing-application' | 'consuming-callback' | 'removed';
	authorizing?: AuthorizingTransaction;
}
export interface ModelCompletion {
	readonly handle: OAuthCompletionSession<SyntheticGrant>;
	readonly expiresAtMs: number;
	readonly receipt: string;
	readonly ownerInitiated: boolean;
	phase: 'awaiting-account-confirmation' | 'committing' | 'removed';
}
export interface CeremonyModelState {
	readonly clock: { nowMs: number };
	readonly store: OAuthTransactionStore<SyntheticGrant>;
	readonly maxTransactions: number;
	readonly maxCompletions: number;
	readonly transactionTtlMs: number;
	readonly completionTtlMs: number;
	readonly transactions: ModelTransaction[];
	readonly completions: ModelCompletion[];
	readonly observedDiscards: string[];
	readonly expectedDiscards: string[];
}

export function createCeremonyModel(props: {
	readonly maxTransactions: number;
	readonly maxCompletionSessions: number;
	readonly transactionTtlMs: number;
	readonly completionTtlMs: number;
}): CeremonyModelState {
	const clock = { nowMs: 1_000 };
	const observedDiscards: string[] = [];
	return {
		clock,
		store: createOAuthTransactionStore({
			now: (): number => clock.nowMs,
			providerGrantSchema: syntheticGrantSchema,
			maxTransactions: props.maxTransactions,
			maxCompletionSessions: props.maxCompletionSessions,
			transactionTtlMs: props.transactionTtlMs,
			completionSessionTtlMs: props.completionTtlMs,
			onDiscardProviderGrant: (grant: SyntheticGrant): void => {
				observedDiscards.push(grant.receipt);
			},
		}),
		maxTransactions: props.maxTransactions,
		maxCompletions: props.maxCompletionSessions,
		transactionTtlMs: props.transactionTtlMs,
		completionTtlMs: props.completionTtlMs,
		transactions: [],
		completions: [],
		observedDiscards,
		expectedDiscards: [],
	};
}

export function discardModeledCompletion(state: CeremonyModelState, entry: ModelCompletion): void {
	if (entry.phase === 'removed') return;
	entry.phase = 'removed';
	state.expectedDiscards.push(entry.receipt);
}

export function reapModeledCeremonies(state: CeremonyModelState): {
	readonly transactionCount: number;
	readonly completionSessionCount: number;
} {
	let transactionCount = 0;
	let completionSessionCount = 0;
	for (const entry of state.transactions) {
		if (entry.phase !== 'removed' && entry.expiresAtMs <= state.clock.nowMs) {
			entry.phase = 'removed';
			transactionCount++;
		}
	}
	for (const entry of state.completions) {
		if (entry.phase !== 'removed' && entry.expiresAtMs <= state.clock.nowMs) {
			discardModeledCompletion(state, entry);
			completionSessionCount++;
		}
	}
	return { transactionCount, completionSessionCount };
}

export function createModeledTransaction(
	state: CeremonyModelState,
	ownerInitiated: boolean,
): ModelTransaction | undefined {
	const input = {
		configRevision: 'synthetic-config',
		agentId: 'hermes',
		applicationIds: [applicationId],
		initiator: ownerInitiated
			? ({
					kind: 'website_owner',
					ownerIdentity: { issuer: modelPrincipal.issuer, userId: modelPrincipal.subject },
				} satisfies Parameters<typeof state.store.createTransaction>[0]['initiator'])
			: ({ kind: 'agent', agentId: 'hermes' } satisfies Parameters<
					typeof state.store.createTransaction
				>[0]['initiator']),
		target: { kind: 'enroll', applicationId } satisfies Parameters<
			typeof state.store.createTransaction
		>[0]['target'],
	};
	// Creation is one of the real store entries that reaps both collections.
	reapModeledCeremonies(state);
	if (
		state.transactions.filter((entry: ModelTransaction): boolean => entry.phase !== 'removed')
			.length >= state.maxTransactions
	) {
		expect((): unknown => state.store.createTransaction(input)).toThrow(
			'OAuth transaction capacity is exhausted.',
		);
		return undefined;
	}
	const created = state.store.createTransaction(input);
	expect(created.expiresAtMs).toBe(state.clock.nowMs + state.transactionTtlMs);
	const entry: ModelTransaction = {
		handle: created,
		ownerInitiated,
		expiresAtMs: state.clock.nowMs + state.transactionTtlMs,
		phase: 'selecting-permissions',
	};
	state.transactions.push(entry);
	return entry;
}

export function bindModeledTransaction(
	state: CeremonyModelState,
	entry: ModelTransaction,
	identity: OAuthBrowserSessionIdentity,
): void {
	const bind = (): unknown =>
		state.store.bindBrowserIdentity({ transactionId: entry.handle.transactionId, identity });
	if (entry.phase !== 'selecting-permissions') {
		expect(bind).toThrow('OAuth transaction is not selecting permissions.');
		return;
	}
	if (entry.expiresAtMs <= state.clock.nowMs) {
		expect(bind).toThrow('OAuth transaction expired.');
		entry.phase = 'removed';
		return;
	}
	if (
		entry.identity !== undefined &&
		(entry.identity.issuer !== identity.issuer || entry.identity.subject !== identity.subject)
	) {
		expect(bind).toThrow('OAuth transaction is already bound to another browser session.');
		return;
	}
	if (
		entry.ownerInitiated &&
		(identity.issuer !== modelPrincipal.issuer || identity.subject !== modelPrincipal.subject)
	) {
		expect(bind).toThrow('OAuth transaction belongs to another website owner.');
		return;
	}
	const bound = state.store.bindBrowserIdentity({
		transactionId: entry.handle.transactionId,
		identity,
	});
	expect(bound.identity).toEqual(identity);
	entry.identity = identity;
}

export function authorizeModeledTransaction(
	state: CeremonyModelState,
	entry: ModelTransaction,
): void {
	const input = {
		transactionId: entry.handle.transactionId,
		applicationId,
		completedApplications: [],
		remainingApplications: [],
		confirmedSelections: oauthPermissionSelectionsSchema.parse({ 'gmail-app': ['gmail.read'] }),
		confirmedScopes: [oauthScopeSchema.parse('https://www.googleapis.com/auth/gmail.readonly')],
		redirectUri: 'https://permissions.example.test/oauth/google/callback',
	};
	if (entry.phase !== 'selecting-permissions') {
		expect((): unknown => state.store.beginApplicationAuthorization(input)).toThrow(
			'OAuth transaction cannot start Google authorization.',
		);
		return;
	}
	if (entry.expiresAtMs <= state.clock.nowMs) {
		expect((): unknown => state.store.beginApplicationAuthorization(input)).toThrow(
			'OAuth transaction expired.',
		);
		entry.phase = 'removed';
		return;
	}
	if (entry.identity === undefined) {
		expect((): unknown => state.store.beginApplicationAuthorization(input)).toThrow(
			'OAuth transaction has no verified browser session.',
		);
		return;
	}
	entry.authorizing = state.store.beginApplicationAuthorization(input);
	expect(entry.authorizing.identity).toEqual(entry.identity);
	entry.phase = 'authorizing-application';
}

export type BrowserFault =
	| 'none'
	| 'subject'
	| 'issuer'
	| 'browser'
	| 'csrf'
	| 'state'
	| 'redirect';

export function principalWithFault(
	fault: BrowserFault,
	identity: OAuthBrowserSessionIdentity = modelPrincipal,
): OAuthBrowserSessionIdentity {
	return {
		issuer: fault === 'issuer' ? `${identity.issuer}/foreign` : identity.issuer,
		subject: fault === 'subject' ? `${identity.subject}.other` : identity.subject,
	};
}

export function differentSecret(secret: string): string {
	return `${secret.startsWith('a') ? 'b' : 'a'}${secret.slice(1)}`;
}

export function consumeModeledCallback(
	state: CeremonyModelState,
	entry: ModelTransaction,
	fault: BrowserFault,
): void {
	const input = {
		transactionId: entry.handle.transactionId,
		identity: principalWithFault(fault, entry.identity),
		browserBindingSecret:
			fault === 'browser'
				? differentSecret(entry.handle.browserBindingSecret)
				: entry.handle.browserBindingSecret,
		oauthState:
			fault === 'state'
				? differentSecret(entry.authorizing?.oauthState ?? 'a'.repeat(43))
				: (entry.authorizing?.oauthState ?? 'a'.repeat(43)),
		redirectUri:
			fault === 'redirect'
				? 'https://foreign.example.test/callback'
				: 'https://permissions.example.test/oauth/google/callback',
	};
	let reason:
		| 'consumed-or-missing'
		| 'expired'
		| 'wrong-state'
		| 'identity-mismatch'
		| 'browser-binding-mismatch'
		| 'invalid-state'
		| 'invalid-redirect'
		| undefined;
	if (entry.phase === 'removed') reason = 'consumed-or-missing';
	else if (entry.expiresAtMs <= state.clock.nowMs) {
		reason = 'expired';
		entry.phase = 'removed';
	} else if (entry.phase !== 'authorizing-application') reason = 'wrong-state';
	else if (fault === 'subject' || fault === 'issuer') reason = 'identity-mismatch';
	else if (fault === 'browser') reason = 'browser-binding-mismatch';
	else if (fault === 'redirect') reason = 'invalid-redirect';
	else if (fault === 'state') reason = 'invalid-state';
	const result = state.store.beginCallbackConsumption(input);
	if (reason !== undefined) expect(result).toEqual({ kind: 'rejected', reason });
	else {
		expect(result.kind).toBe('accepted');
		entry.phase = 'consuming-callback';
	}
}

export function completeModeledCallback(
	state: CeremonyModelState,
	entry: ModelTransaction,
): ModelCompletion | undefined {
	const receipt = `synthetic-grant-${state.transactions.indexOf(entry)}`;
	const input = { transactionId: entry.handle.transactionId, providerGrant: { receipt } };
	if (entry.phase !== 'consuming-callback') {
		expect((): unknown => state.store.completeCallback(input)).toThrow(
			'OAuth callback is not consuming.',
		);
		return undefined;
	}
	if (entry.expiresAtMs <= state.clock.nowMs) {
		expect((): unknown => state.store.completeCallback(input)).toThrow(
			'OAuth transaction expired during exchange.',
		);
		entry.phase = 'removed';
		return undefined;
	}
	const result = state.store.completeCallback(input);
	if (
		state.completions.filter(
			(completion: ModelCompletion): boolean => completion.phase !== 'removed',
		).length >= state.maxCompletions
	) {
		expect(result).toEqual({ kind: 'capacity-exhausted' });
		return undefined;
	}
	if (result.kind !== 'created') throw new Error('Expected a completion below modeled capacity.');
	expect(result.session.identity).toEqual(entry.identity);
	expect(result.session.expiresAtMs).toBe(state.clock.nowMs + state.completionTtlMs);
	entry.phase = 'removed';
	const completion: ModelCompletion = {
		handle: result.session,
		receipt,
		ownerInitiated: entry.ownerInitiated,
		expiresAtMs: state.clock.nowMs + state.completionTtlMs,
		phase: 'awaiting-account-confirmation',
	};
	state.completions.push(completion);
	return completion;
}

export function decideModeledCompletion(
	state: CeremonyModelState,
	entry: ModelCompletion,
	fault: BrowserFault,
	cancel: boolean,
): void {
	const input = {
		completionSessionId: entry.handle.completionSessionId,
		identity: principalWithFault(fault, entry.handle.identity),
		browserBindingSecret:
			fault === 'browser'
				? differentSecret(entry.handle.browserBindingSecret)
				: entry.handle.browserBindingSecret,
		csrfToken:
			fault === 'csrf' ? differentSecret(entry.handle.csrfSecret) : entry.handle.csrfSecret,
	};
	let reason:
		| 'consumed-or-missing'
		| 'expired'
		| 'wrong-state'
		| 'identity-mismatch'
		| 'browser-binding-mismatch'
		| 'csrf-mismatch'
		| undefined;
	if (entry.phase === 'removed') reason = 'consumed-or-missing';
	else if (entry.expiresAtMs <= state.clock.nowMs) {
		reason = 'expired';
		discardModeledCompletion(state, entry);
	} else if (entry.phase !== 'awaiting-account-confirmation') reason = 'wrong-state';
	else if (fault === 'subject' || fault === 'issuer') reason = 'identity-mismatch';
	else if (fault === 'browser') reason = 'browser-binding-mismatch';
	else if (fault === 'csrf') reason = 'csrf-mismatch';
	if (cancel) {
		const result = state.store.cancelCompletion(input);
		if (reason !== undefined) expect(result).toBeUndefined();
		else {
			expect(result?.transactionId).toBe(entry.handle.transactionId);
			discardModeledCompletion(state, entry);
		}
	} else {
		const result = state.store.beginCompletionCommit(input);
		if (reason !== undefined) expect(result).toEqual({ kind: 'rejected', reason });
		else {
			expect(result.kind).toBe('accepted');
			entry.phase = 'committing';
		}
	}
}
