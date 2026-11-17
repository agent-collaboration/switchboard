import type { SignInDeadline } from '#sign-in-core/contracts/sign-in-platform';
import {
	renewOrganizationStampForUse,
	type OrganizationStampRenewal,
	type OrganizationStampRenewalProps,
} from '#sign-in-core/organizations/organization-stamp-renewal';
import type { SignInStoreFailure } from '#sign-in-core/storage/models/sign-in-database';
import type { OrganizationId } from '#sign-in-core/storage/models/sign-in-store';
import type { OrganizationMembershipRecords } from '#sign-in-core/storage/organization-membership-store';

export type OrganizationKeyChangeResult =
	| { readonly kind: 'current-key'; readonly organizationId: OrganizationId }
	| {
			readonly kind: 'unfinished';
			readonly organizationId: OrganizationId;
			readonly renewal: OrganizationStampRenewal;
	  };
export type OrganizationKeyChangeRun =
	| { readonly kind: 'complete'; readonly organizations: readonly OrganizationKeyChangeResult[] }
	| SignInStoreFailure;

/** A stamp in doubt under the old key is settled first, then re-signed under the current one. */
const maximumKeyChangeRounds = 2;

/**
 * B2 rule 6: before the old key is retired, every ready organization (idle, or far from expiry)
 * goes through the same guarded rules until its confirmed stamp names the current key. Anything
 * short of that is reported unfinished, never counted done.
 */
export async function reSignOrganizationsForKeyChange(
	props: Omit<OrganizationStampRenewalProps, 'organizationId' | 'deadline'> & {
		readonly organizations: Pick<OrganizationMembershipRecords, 'readyOrganizationIds'>;
		/** One deadline per guard run, as on the request path (D7). */
		readonly startDeadline: () => SignInDeadline;
	},
): Promise<OrganizationKeyChangeRun> {
	const ready = await props.organizations.readyOrganizationIds();
	if (ready.kind === 'store-unavailable') return ready;
	const organizations = await Promise.all(
		ready.value.map(async (organizationId): Promise<OrganizationKeyChangeResult> => {
			let renewal: OrganizationStampRenewal = { kind: 'current' };
			for (let round = 0; round < maximumKeyChangeRounds; round += 1) {
				// oxlint-disable-next-line no-await-in-loop -- the second round needs the first settled.
				const deadline = props.startDeadline();
				try {
					renewal = (
						await renewOrganizationStampForUse({
							...props,
							organizationId,
							deadline: deadline.signal,
						})
					).renewal;
				} finally {
					deadline.cancel();
				}
				// oxlint-disable-next-line no-await-in-loop -- the record decides whether to go again.
				const record = await props.stamps.readStampRecord(organizationId);
				if (record.kind === 'store-unavailable')
					return { kind: 'unfinished', organizationId, renewal: record };
				const value = record.value;
				if (value?.sent === null && value.confirmed?.signingKeyId === props.currentSigningKeyId)
					return { kind: 'current-key', organizationId };
				if (renewal.kind !== 'renewed') break;
			}
			return { kind: 'unfinished', organizationId, renewal };
		}),
	);
	return { kind: 'complete', organizations };
}
