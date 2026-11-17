import type {
	AuthorizationRevisionPush,
	AuthorizationRevisionPushAnswer,
} from '#sign-in-core/central-link/authorization-revision-push-client';
import type { CentralLinkClient } from '#sign-in-core/central-link/central-link-client';
import type { SignInClock, SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import type { PrepareOrganizationFleetCall } from '#sign-in-core/organizations/organization-fleet-call';
import { withinDeadline } from '#sign-in-core/organizations/within-deadline';
import type {
	AuthorizationRevisionDeliveryRecords,
	PendingAuthorizationRevisions,
	PendingOrganizationRevision,
	PendingPersonRevision,
} from '#sign-in-core/storage/authorization-revision-delivery-store';
import type {
	SignInStoreFailure,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import { availableStoreValue } from '#sign-in-core/storage/store-query-results';

/** A failed or unconfirmed push is tried again after this long; the periodic drain finds it. */
export const authorizationRevisionRetryMilliseconds = 60_000;
/** Bounds one read of pending rows; delivery on use reads again until none remain. */
export const authorizationRevisionDrainBatchSize = 100;

export type AuthorizationRevisionDelivery =
	| { readonly kind: 'acknowledged' }
	/** Central confirmed a revision this source never had: a recovery discrepancy, never a reset. */
	| { readonly kind: 'discrepancy'; readonly acknowledgedRevision: number }
	| {
			readonly kind: 'deferred';
			readonly reason: DeferralReason;
	  };
/** Why a row stays pending: central's answer to its push, or its organization row's. */
type DeferralReason =
	| Extract<AuthorizationRevisionPushAnswer, { kind: 'refused' | 'unknown' }>['reason']
	| 'answered-unavailable'
	| 'organization-not-delivered';
export type AuthorizationRevisionDrainRun =
	| {
			readonly kind: 'complete';
			readonly acknowledged: number;
			readonly deferred: number;
			readonly discrepancies: number;
	  }
	| SignInStoreFailure;

/**
 * One organization's delivery inside a guard run: every row acknowledged, or not.
 * `central-answered-unavailable`: a push met central's own 503, which pinned central also
 * answers for an unstamped store, so the run may probe for a forgotten organization (R-push503).
 */
export type OrganizationRevisionDelivery =
	| {
			readonly kind: 'delivered' | 'pending' | 'central-answered-unavailable';
			readonly acknowledged: number;
			readonly deferred: number;
			readonly discrepancies: number;
	  }
	| { readonly kind: 'not-attempted' }
	| SignInStoreFailure;

interface RevisionDeliveryProps {
	readonly store: AuthorizationRevisionDeliveryRecords;
	readonly centralClient: Pick<CentralLinkClient, 'pushAuthorizationRevision'>;
	readonly clock: SignInClock;
	/** D7: the guard run's one deadline; every push races it and carries its signal. */
	readonly deadline: AbortSignal;
}

interface DeliveryTotals {
	acknowledged: number;
	deferred: number;
	discrepancies: number;
}

/**
 * WS3 drain on use (Lead, 12 Nov): inside one guard run, push every unacknowledged row of this
 * organization, its fence before its person pairs, whatever their retry schedule. r3 section 5
 * still holds: only central's post-commit ACK is recorded, everything else stays pending.
 *
 * R-batch (Lead, 13 Nov; Q1 = A): batches repeat until a read finds none pending, so `delivered`
 * always follows a re-read that came back empty. A row that advanced while its older ACK was
 * recorded is read again and pushed at its new revision. Any row left undelivered, a row the run
 * already pushed at that revision, or the deadline ends the run `pending`.
 */
export async function deliverOrganizationRevisions(
	props: RevisionDeliveryProps & { readonly organizationId: string },
): Promise<OrganizationRevisionDelivery> {
	const totals: DeliveryTotals = { acknowledged: 0, deferred: 0, discrepancies: 0 };
	const pushedThisRun = new Set<string>();
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- each read follows the ACKs the last batch recorded.
		const pending = await props.store.readPending({
			limit: authorizationRevisionDrainBatchSize,
			organizationId: props.organizationId,
		});
		if (pending.kind === 'store-unavailable') return pending;
		const keys = [
			...pending.value.organizations.map(
				(row) => `organization:${row.organizationId}:${row.revision}`,
			),
			...pending.value.persons.map((row) => `person:${row.subjectId}:${row.revision}`),
		];
		if (keys.length === 0) return { kind: 'delivered', ...totals };
		// Q2: rows remain and the run's budget is spent, so none of them can be pushed.
		if (props.deadline.aborted) return { kind: 'pending', ...totals };
		// Acknowledged but not recorded at that revision: pushing it again would never land it.
		if (keys.some((key) => pushedThisRun.has(key))) return { kind: 'pending', ...totals };
		for (const key of keys) pushedThisRun.add(key);
		// oxlint-disable-next-line no-await-in-loop -- one batch at a time, against fresh rows.
		const outcomes = await deliverBatch(props, pending.value);
		if (outcomes.kind === 'store-unavailable') return outcomes;
		for (const outcome of outcomes.value) {
			if (outcome.kind === 'acknowledged') totals.acknowledged += 1;
			else if (outcome.kind === 'deferred') totals.deferred += 1;
			else totals.discrepancies += 1;
		}
		if (
			outcomes.value.some(
				(outcome) => outcome.kind === 'deferred' && outcome.reason === 'answered-unavailable',
			)
		)
			return { kind: 'central-answered-unavailable', ...totals };
		if (outcomes.value.some((outcome) => outcome.kind !== 'acknowledged'))
			return { kind: 'pending', ...totals };
	}
}

async function deliverBatch(
	props: RevisionDeliveryProps,
	pending: PendingAuthorizationRevisions,
): Promise<SignInStoreResult<AuthorizationRevisionDelivery[]>> {
	const outcomes: AuthorizationRevisionDelivery[] = [];
	const undeliveredOrganizations = new Set<string>();
	for (const row of pending.organizations) {
		const outcome = await deliverOrganization(props, row);
		if (outcome.kind === 'store-unavailable') return outcome;
		if (outcome.kind !== 'acknowledged') undeliveredOrganizations.add(row.organizationId);
		outcomes.push(outcome);
	}
	for (const row of pending.persons) {
		if (undeliveredOrganizations.has(row.organizationId)) {
			const deferred = await deferPerson(props, row, 'organization-not-delivered');
			if (deferred.kind === 'store-unavailable') return deferred;
			outcomes.push(deferred);
			continue;
		}
		let outcome = await deliverPerson(props, row);
		// r3 section 5: a missing recipient floor is resent even if the source once stored its ACK.
		if (outcome.kind === 'deferred' && outcome.reason === 'organization-floor-missing') {
			const resent = await resendOrganization(props, row.organizationId);
			if (resent.kind === 'store-unavailable') return resent;
			if (resent.kind === 'acknowledged') {
				outcome = await deliverPerson(props, row);
			} else {
				undeliveredOrganizations.add(row.organizationId);
			}
		}
		if (outcome.kind === 'store-unavailable') return outcome;
		outcomes.push(outcome);
	}
	return availableStoreValue(outcomes);
}

async function deliverOrganization(
	props: RevisionDeliveryProps,
	row: PendingOrganizationRevision,
): Promise<AuthorizationRevisionDelivery | SignInStoreFailure> {
	const answer = await push(props, {
		kind: 'organization',
		organizationId: row.organizationId,
		revision: row.revision,
		state: row.state,
		permissionPolicyDigest: row.permissionPolicyDigest,
	});
	if (answer.kind === 'acknowledged') {
		const recorded = await props.store.recordOrganizationAcknowledgement({
			organizationId: row.organizationId,
			acknowledgedRevision: answer.acknowledgedRevision,
		});
		if (recorded.kind === 'store-unavailable') return recorded;
		return acknowledgementOutcome(recorded.value, answer.acknowledgedRevision, row.revision);
	}
	const deferred = await props.store.deferOrganization({
		organizationId: row.organizationId,
		pushedRevision: row.revision,
		nextAttemptAt: props.clock.now() + authorizationRevisionRetryMilliseconds,
	});
	return deferred.kind === 'store-unavailable'
		? deferred
		: { kind: 'deferred', reason: deferralReason(answer) };
}

/** Re-reads the org fence's current version and pushes it; the ACK update never lowers. */
async function resendOrganization(
	props: RevisionDeliveryProps,
	organizationId: string,
): Promise<AuthorizationRevisionDelivery | SignInStoreFailure> {
	const current = await props.store.readOrganization(organizationId);
	if (current.kind === 'store-unavailable') return current;
	if (current.value === null) return { kind: 'deferred', reason: 'organization-not-delivered' };
	return deliverOrganization(props, current.value);
}

async function deliverPerson(
	props: RevisionDeliveryProps,
	row: PendingPersonRevision,
): Promise<AuthorizationRevisionDelivery | SignInStoreFailure> {
	const answer = await push(props, {
		kind: 'person',
		organizationId: row.organizationId,
		personId: row.personId,
		subjectId: row.subjectId,
		revision: row.revision,
		state: row.state,
	});
	if (answer.kind === 'acknowledged') {
		const recorded = await props.store.recordPersonAcknowledgement({
			subjectId: row.subjectId,
			organizationId: row.organizationId,
			personId: row.personId,
			acknowledgedRevision: answer.acknowledgedRevision,
		});
		if (recorded.kind === 'store-unavailable') return recorded;
		return acknowledgementOutcome(recorded.value, answer.acknowledgedRevision, row.revision);
	}
	return deferPerson(props, row, deferralReason(answer));
}

function deferralReason(
	answer: Exclude<AuthorizationRevisionPushAnswer, { kind: 'acknowledged' }>,
): DeferralReason {
	return answer.kind === 'answered-unavailable' ? 'answered-unavailable' : answer.reason;
}

async function deferPerson(
	props: RevisionDeliveryProps,
	row: PendingPersonRevision,
	reason: DeferralReason,
): Promise<AuthorizationRevisionDelivery | SignInStoreFailure> {
	const deferred = await props.store.deferPerson({
		subjectId: row.subjectId,
		pushedRevision: row.revision,
		nextAttemptAt: props.clock.now() + authorizationRevisionRetryMilliseconds,
	});
	return deferred.kind === 'store-unavailable' ? deferred : { kind: 'deferred', reason };
}

async function push(
	props: RevisionDeliveryProps,
	body: AuthorizationRevisionPush,
): Promise<AuthorizationRevisionPushAnswer> {
	try {
		// The guard already decided this run may reach Fleet; the deadline still bounds it.
		return await withinDeadline(
			props.deadline,
			async () => props.centralClient.pushAuthorizationRevision(body, { signal: props.deadline }),
			{ kind: 'unknown', reason: 'timeout' },
		);
	} catch {
		return { kind: 'unknown', reason: 'unavailable' };
	}
}

/** An ACK above the pushed revision is fine if the row has since reached it; above that it is not. */
function acknowledgementOutcome(
	recorded: 'recorded' | 'not-recorded',
	acknowledgedRevision: number,
	pushedRevision: number,
): AuthorizationRevisionDelivery {
	if (recorded === 'recorded' || acknowledgedRevision <= pushedRevision)
		return { kind: 'acknowledged' };
	return { kind: 'discrepancy', acknowledgedRevision };
}

/**
 * The after-response hint's entry point (WS3: no timer runs it). Each organization with rows
 * due goes through its own guard run, which renews its stamp and then delivers its rows, so no
 * row is pushed twice and nothing recurses. Its outcome is observable and never thrown.
 */
export async function runAuthorizationRevisionDrain(props: {
	readonly store: { readonly revisionDelivery: AuthorizationRevisionDeliveryRecords };
	readonly platform: Pick<SignInPlatform, 'log'>;
	readonly prepareFleetCall: PrepareOrganizationFleetCall;
}): Promise<AuthorizationRevisionDrainRun> {
	let run: AuthorizationRevisionDrainRun;
	try {
		const pending = await props.store.revisionDelivery.readPending({
			limit: authorizationRevisionDrainBatchSize,
		});
		if (pending.kind === 'store-unavailable') run = pending;
		else {
			const organizations = [
				...new Set([
					...pending.value.organizations.map((row) => row.organizationId),
					...pending.value.persons.map((row) => row.organizationId),
				]),
			];
			const totals = { acknowledged: 0, deferred: 0, discrepancies: 0 };
			for (const organizationId of organizations) {
				// oxlint-disable-next-line no-await-in-loop -- one guard run per organization, in order.
				const delivery = (await props.prepareFleetCall(organizationId)).revisions;
				if (
					delivery.kind === 'delivered' ||
					delivery.kind === 'pending' ||
					delivery.kind === 'central-answered-unavailable'
				) {
					totals.acknowledged += delivery.acknowledged;
					totals.deferred += delivery.deferred;
					totals.discrepancies += delivery.discrepancies;
				} else totals.deferred += 1;
			}
			run = { kind: 'complete', ...totals };
		}
	} catch {
		props.platform.log({ kind: 'authorization-drain-unavailable', reason: 'job-error' });
		return { kind: 'store-unavailable', reason: 'database-error' };
	}
	props.platform.log(
		run.kind === 'complete'
			? {
					kind: 'authorization-drain-summary',
					acknowledged: run.acknowledged,
					deferred: run.deferred,
					discrepancies: run.discrepancies,
				}
			: { kind: 'authorization-drain-unavailable', reason: run.reason },
	);
	return run;
}
