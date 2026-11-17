import type { CentralLinkClient } from '#sign-in-core/central-link/central-link-client';
import {
	deliverOrganizationRevisions,
	type OrganizationRevisionDelivery,
} from '#sign-in-core/organizations/authorization-revision-drainer';
import type { ForgottenOrganizationRecovery } from '#sign-in-core/organizations/organization-central-recovery';
import {
	renewOrganizationStampForUse,
	type OrganizationStampRenewal,
	type OrganizationStampRenewalProps,
} from '#sign-in-core/organizations/organization-stamp-renewal';
import { withinDeadline } from '#sign-in-core/organizations/within-deadline';
import type { AuthorizationRevisionDeliveryRecords } from '#sign-in-core/storage/authorization-revision-delivery-store';

/** Whether the original Fleet call may go out, with what the guard run did to get there. */
export type OrganizationFleetCallReadiness = {
	readonly kind: 'ready' | 'unavailable';
	readonly renewal: OrganizationStampRenewal;
	readonly revisions: OrganizationRevisionDelivery;
};
/** The guard's entry: the server-only endpoint parses the ID before any read or send. */
export type PrepareOrganizationFleetCall = (
	organizationId: string,
) => Promise<OrganizationFleetCallReadiness>;

/**
 * One guard run before each sign-in to Fleet call, under one D7 deadline:
 * 1. the stamp step (B2 rules 1-5);
 * 2. over a usable stamp, this organization's pending revisions, fence then person pairs.
 *
 * WS3, Lead's Q1 = A: a revision still unacknowledged at the end keeps the call back, so central
 * always sees a revocation before any call that could depend on it.
 */
export async function prepareOrganizationFleetCall(
	props: OrganizationStampRenewalProps & {
		readonly revisions: AuthorizationRevisionDeliveryRecords;
		readonly centralClient: OrganizationStampRenewalProps['centralClient'] &
			Pick<CentralLinkClient, 'pushAuthorizationRevision'>;
	},
): Promise<OrganizationFleetCallReadiness> {
	const stamp = await renewOrganizationStampForUse(props);
	if (stamp.kind === 'unavailable')
		return { kind: 'unavailable', renewal: stamp.renewal, revisions: { kind: 'not-attempted' } };
	const revisions = await deliverOrganizationRevisions({
		store: props.revisions,
		centralClient: props.centralClient,
		clock: props.clock,
		deadline: props.deadline,
		organizationId: props.organizationId,
	});
	return {
		kind: revisions.kind === 'delivered' ? 'ready' : 'unavailable',
		renewal: stamp.renewal,
		revisions,
	};
}

/** One sign-in to Fleet call, as its caller describes it to the run. */
export interface OrganizationFleetCall<TAnswer> {
	readonly organizationId: string;
	/**
	 * Sends the original call. The first send is not bounded by the run's deadline (D7, Lead
	 * 13 Nov); the one retry after a recovery carries it.
	 */
	readonly send: (retry: { readonly signal: AbortSignal } | null) => Promise<TAnswer>;
	/** Whether central itself answered 503, which pinned central also answers when unstamped. */
	readonly answeredUnavailable: (answer: TAnswer) => boolean;
	/** The retry's answer if the run's deadline ends it first. */
	readonly atDeadline: TAnswer;
}

/** What a recovery did in this run, if one was needed. */
export type FleetCallRecovery =
	| { readonly kind: 'not-needed' }
	| {
			readonly kind: 'attempted';
			readonly trigger: 'call' | 'push';
			readonly result: ForgottenOrganizationRecovery;
			/** The guard run after a recovery, which delivers the revisions it forgot (R-floors). */
			readonly afterRecovery: OrganizationFleetCallReadiness | null;
	  };

export type OrganizationFleetCallOutcome<TAnswer> =
	/** The guard kept the call back; nothing was sent. */
	| {
			readonly kind: 'held';
			readonly readiness: OrganizationFleetCallReadiness;
			readonly recovery: FleetCallRecovery;
	  }
	/** The call went out (at most twice); this is the answer its caller returns. */
	| {
			readonly kind: 'sent';
			readonly answer: TAnswer;
			readonly recovery: FleetCallRecovery;
	  };

/** The run's entry for a call through the guard, used by each sign-in to Fleet call. */
export type RunOrganizationFleetCall = <TAnswer>(
	call: OrganizationFleetCall<TAnswer>,
) => Promise<OrganizationFleetCallOutcome<TAnswer>>;

/** The guard's two server-only steps, each inside the same deadline as the whole run. */
export interface OrganizationFleetCallSteps {
	readonly prepare: () => Promise<OrganizationFleetCallReadiness>;
	readonly recover: () => Promise<ForgottenOrganizationRecovery>;
}

/**
 * WS7 R-notdue and R-push503 (Lead, 13 Nov). One run budget bounds the guard and, after
 * central's own 503, the probe, the recovery and one retry; the first call is never bounded.
 *
 * - A push answered 503 holds the call back; if central holds nothing, recover, deliver again,
 *   then send the call.
 * - A call answered 503: if central holds nothing, recover, deliver the forgotten revisions and
 *   retry once. Anything short of that returns the original answer unchanged.
 */
export async function runOrganizationFleetCall<TAnswer>(props: {
	readonly steps: OrganizationFleetCallSteps;
	readonly deadline: AbortSignal;
	readonly call: OrganizationFleetCall<TAnswer>;
}): Promise<OrganizationFleetCallOutcome<TAnswer>> {
	const readiness = await props.steps.prepare();
	if (readiness.kind === 'unavailable') {
		if (readiness.revisions.kind !== 'central-answered-unavailable')
			return { kind: 'held', readiness, recovery: { kind: 'not-needed' } };
		const recovery = await recoverThenPrepare(props.steps, 'push');
		if (recovery.afterRecovery?.kind !== 'ready')
			return { kind: 'held', readiness: recovery.afterRecovery ?? readiness, recovery };
		return { kind: 'sent', answer: await props.call.send(null), recovery };
	}
	const original = await props.call.send(null);
	if (!props.call.answeredUnavailable(original))
		return { kind: 'sent', answer: original, recovery: { kind: 'not-needed' } };
	const recovery = await recoverThenPrepare(props.steps, 'call');
	if (recovery.afterRecovery?.kind !== 'ready' || props.deadline.aborted)
		return { kind: 'sent', answer: original, recovery };
	const signal = props.deadline;
	const retried = await withinDeadline(
		signal,
		async () => props.call.send({ signal }),
		props.call.atDeadline,
	);
	return { kind: 'sent', answer: retried, recovery };
}

async function recoverThenPrepare(
	steps: OrganizationFleetCallSteps,
	trigger: 'call' | 'push',
): Promise<Extract<FleetCallRecovery, { kind: 'attempted' }>> {
	const result = await steps.recover();
	return {
		kind: 'attempted',
		trigger,
		result,
		afterRecovery: result.kind === 'recovered' ? await steps.prepare() : null,
	};
}
