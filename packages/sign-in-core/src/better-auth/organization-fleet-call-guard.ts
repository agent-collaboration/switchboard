import { createSignInProvider } from '#sign-in-core/better-auth/provider-configuration';
import { createProviderRequestState } from '#sign-in-core/better-auth/provider-request-state';
import type { SignInHttpConfiguration } from '#sign-in-core/better-auth/sign-in-http-handler';
import type { SignInDeadlines } from '#sign-in-core/contracts/sign-in-platform';
import {
	runOrganizationFleetCall,
	type OrganizationFleetCallReadiness,
	type PrepareOrganizationFleetCall,
	type RunOrganizationFleetCall,
} from '#sign-in-core/organizations/organization-fleet-call';
import type { OrganizationKeyChangeRun } from '#sign-in-core/organizations/organization-key-change';

/** Each guard run enters native server-only dispatch with fresh request state, so signing
 * keeps the provider's own key selection. A failed dispatch never lets the call out. */
export function createOrganizationFleetCallGuard(
	configuration: SignInHttpConfiguration,
): PrepareOrganizationFleetCall {
	return async (organizationId) => {
		const provider = createSignInProvider({
			...configuration,
			authority: { kind: 'public' },
			requestState: createProviderRequestState(),
		});
		try {
			return await provider.api.prepareOrganizationFleetCall({ body: { organizationId } });
		} catch {
			return {
				kind: 'unavailable',
				renewal: { kind: 'signing-unavailable' },
				revisions: { kind: 'not-attempted' },
			};
		}
	};
}

const heldByFailedDispatch: OrganizationFleetCallReadiness = {
	kind: 'unavailable',
	renewal: { kind: 'signing-unavailable' },
	revisions: { kind: 'not-attempted' },
};

/** Every step of one run gets the run's own deadline, so they share one budget (D7). */
function oneRunDeadline(signal: AbortSignal): SignInDeadlines {
	return { start: () => ({ signal, cancel: () => undefined }) };
}

/**
 * WS7 (Lead, 13 Nov): one deadline per sign-in to Fleet call, started here and shared by the
 * guard, and after central's own 503, the probe, the recovery and the one retry. Each step still
 * enters native server-only dispatch, so signing keeps the provider's own key selection.
 */
export function createOrganizationFleetCallRunner(
	configuration: SignInHttpConfiguration,
): RunOrganizationFleetCall {
	return async (call) => {
		const deadline = configuration.platform.deadlines.start(
			configuration.configuration.organizationStampRenewalDeadlineMilliseconds,
		);
		try {
			const provider = createSignInProvider({
				...configuration,
				platform: { ...configuration.platform, deadlines: oneRunDeadline(deadline.signal) },
				authority: { kind: 'public' },
				requestState: createProviderRequestState(),
			});
			const body = { organizationId: call.organizationId };
			return await runOrganizationFleetCall({
				deadline: deadline.signal,
				call,
				steps: {
					prepare: async () =>
						provider.api.prepareOrganizationFleetCall({ body }).catch(() => heldByFailedDispatch),
					recover: async () =>
						provider.api.recoverForgottenOrganization({ body }).catch(() => ({
							kind: 'not-recovered' as const,
							renewal: { kind: 'signing-unavailable' as const },
						})),
				},
			});
		} finally {
			deadline.cancel();
		}
	};
}

/** B2 rule 6's server-only entry, for the operator's key change; no host schedules it. */
export function createOrganizationKeyChangeResign(
	configuration: SignInHttpConfiguration,
): () => Promise<OrganizationKeyChangeRun> {
	return async () =>
		createSignInProvider({
			...configuration,
			authority: { kind: 'public' },
			requestState: createProviderRequestState(),
		}).api.reSignOrganizationsForKeyChange({ body: {} });
}
