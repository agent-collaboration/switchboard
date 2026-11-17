import type { ProvisionOrganizationAnswer } from '#sign-in-core/organizations/organization-provisioning';
import type {
	OrganizationStampFacts,
	OrganizationStampRenewal,
	OrganizationStampRenewalProps,
	OrganizationStampTryOutcome,
} from '#sign-in-core/organizations/organization-stamp-renewal';
import { withinDeadline } from '#sign-in-core/organizations/within-deadline';
import type { SignInStoreFailure } from '#sign-in-core/storage/models/sign-in-database';

/** `none` is central's own answer that it holds no stamp; a slow or broken link is never `none`. */
export type CentralStampRead =
	| { readonly kind: 'current'; readonly stamp: OrganizationStampFacts }
	| { readonly kind: 'none' }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'timeout' };

/** Central's digest read, inside the run's deadline (D7). */
export async function readCentralStamp(
	props: OrganizationStampRenewalProps,
): Promise<CentralStampRead> {
	try {
		const current = await withinDeadline(
			props.deadline,
			async () =>
				props.centralClient.readStatementDigest(props.organizationId, {
					signal: props.deadline,
				}),
			{ kind: 'unavailable', reason: 'timeout' } as const,
		);
		if (current.kind === 'current')
			return {
				kind: 'current',
				stamp: {
					digest: current.digest,
					expiresAt: current.expiresAt,
					signingKeyId: current.signingKeyId,
				},
			};
		if (current.kind === 'none') return { kind: 'none' };
		return current.reason === 'timeout' ? { kind: 'timeout' } : { kind: 'unavailable' };
	} catch {
		return { kind: 'unavailable' };
	}
}

/**
 * WS7 (Lead, 12 Nov): central started empty and holds no stamp for an organization sign-in calls
 * ready. It is called only once central has answered `none`, with the record already empty.
 *
 * 1. R-floors (13 Nov): forget this organization's ACKs first, since central holds none of them.
 *    Done before the setup, so a run that ends early still leaves its revisions pending.
 * 2. Sign a fresh setup statement (no `replaces`) and provision it inside this run's deadline.
 *    It takes no sent slot: setup is idempotent at central, and the readback records its stamp.
 * 3. On `provisioned`, seed the record from central's digest read (D5).
 *
 * A setup or readback that does not land counts one try (unanswered, or refused with its reason)
 * and leaves the record empty, so the call waits and the next use tries again.
 */
export async function reprovisionFresh(
	props: OrganizationStampRenewalProps,
): Promise<OrganizationStampRenewal> {
	const forgotten = await props.revisions.forgetCentralAcknowledgements(props.organizationId);
	if (forgotten.kind === 'store-unavailable') return forgotten;
	let statement: string;
	try {
		statement = await props.sign({ organizationId: props.organizationId });
	} catch {
		return { kind: 'central-empty' };
	}
	let answer: ProvisionOrganizationAnswer;
	try {
		answer = await withinDeadline(
			props.deadline,
			async () =>
				props.centralClient.provisionOrganization({
					organizationId: props.organizationId,
					organizationStatement: statement,
					signal: props.deadline,
				}),
			{ kind: 'unknown', reason: 'timeout' },
		);
	} catch {
		answer = { kind: 'unknown', reason: 'unavailable' };
	}
	if (answer.kind === 'unknown') return recordSetupTry(props, `unanswered-${answer.reason}`);
	if (answer.kind === 'refused') return recordSetupTry(props, `refused-${answer.reason}`);
	const stored = await readCentralStamp(props);
	if (stored.kind !== 'current')
		return recordSetupTry(
			props,
			stored.kind === 'timeout' ? 'unanswered-timeout' : 'unanswered-seed-unavailable',
		);
	const seeded = await props.stamps.seedConfirmedStamp({
		organizationId: props.organizationId,
		stamp: stored.stamp,
	});
	if (seeded.kind === 'store-unavailable') return seeded;
	// Another writer seeded the record first: theirs stands, and this run did not set it up.
	return seeded.value ? { kind: 'reprovisioned' } : { kind: 'contended' };
}

async function recordSetupTry(
	props: OrganizationStampRenewalProps,
	outcome: OrganizationStampTryOutcome,
): Promise<OrganizationStampRenewal> {
	const recorded = await props.stamps.recordUnsentTry({
		organizationId: props.organizationId,
		outcome,
		now: props.clock.now(),
	});
	return recorded.kind === 'store-unavailable' ? recorded : { kind: 'central-empty' };
}

/** What a recovery attempt found, after a Fleet call or a push met central's own 503. */
export type ForgottenOrganizationRecovery =
	/** Central held nothing; the organization is set up again, seeded, its ACKs forgotten. */
	| { readonly kind: 'recovered' }
	/** The probe did not answer `none`, so the 503 stands as it was. */
	| { readonly kind: 'not-forgotten'; readonly probe: Exclude<CentralStampRead['kind'], 'none'> }
	/** No time was left in the run, so nothing was probed. */
	| { readonly kind: 'budget-spent' }
	/** Another run changed the record first; this run leaves it to them. */
	| { readonly kind: 'contended' }
	/** Central held nothing, but the fresh setup did not land; the next use tries again. */
	| { readonly kind: 'not-recovered'; readonly renewal: OrganizationStampRenewal }
	| SignInStoreFailure;

/**
 * WS7 R-notdue and R-push503 (Lead, 13 Nov): pinned central `e847a888` answers an unstamped
 * store with a bare 503, the same as being unavailable. After that 503, and only with budget
 * left, probe the digest read. Only an explicit `none` forgets the record (conditionally) and
 * sets the organization up again; any other probe outcome leaves everything as it was.
 */
export async function recoverForgottenOrganization(
	props: OrganizationStampRenewalProps,
): Promise<ForgottenOrganizationRecovery> {
	if (props.deadline.aborted) return { kind: 'budget-spent' };
	// The record as it stood when the 503 came back, read before the probe: a `none` answered
	// later never clears a stamp another writer confirmed or claimed in the meantime.
	const record = await props.stamps.readStampRecord(props.organizationId);
	if (record.kind === 'store-unavailable') return record;
	// Only an organization sign-in calls ready is ever set up again.
	if (record.value === null || record.value.fleetState !== 'ready')
		return { kind: 'not-recovered', renewal: { kind: 'not-ready' } };
	if (record.value.sent !== null) return { kind: 'contended' };
	const confirmed = record.value.confirmed;
	const probe = await readCentralStamp(props);
	if (probe.kind !== 'none') return { kind: 'not-forgotten', probe: probe.kind };
	if (confirmed !== null) {
		const forgotten = await props.stamps.forgetConfirmedStamp({
			organizationId: props.organizationId,
			digest: confirmed.digest,
		});
		if (forgotten.kind === 'store-unavailable') return forgotten;
		if (!forgotten.value) return { kind: 'contended' };
	}
	const renewal = await reprovisionFresh(props);
	return renewal.kind === 'reprovisioned'
		? { kind: 'recovered' }
		: { kind: 'not-recovered', renewal };
}
