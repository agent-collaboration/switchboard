import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	epochMillisecondsSchema,
	type SignInPlatform,
} from '#sign-in-core/contracts/sign-in-platform';
import {
	organizationChangePhaseSchema,
	organizationChangeRecordId,
	organizationPeopleChangeSchema,
	type OrganizationChangePhase,
	type OrganizationChangeRecords,
	type OrganizationPeopleChange,
} from '#sign-in-core/organizations/organization-change-record';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import { signInAudit } from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

const auditFields = {
	id: z.string().min(1),
	phase: organizationChangePhaseSchema,
	at: epochMillisecondsSchema,
};
const [invited, cancelled, accepted, removed] = organizationPeopleChangeSchema.options;
const organizationAuditRowSchema = z.discriminatedUnion('change', [
	invited.extend(auditFields),
	cancelled.extend(auditFields),
	accepted.extend(auditFields),
	removed.extend(auditFields),
]);
export type OrganizationAuditRow = z.infer<typeof organizationAuditRowSchema>;
export interface OrganizationPeopleAudit extends OrganizationChangeRecords {
	readonly read: (
		change: OrganizationPeopleChange,
	) => Promise<SignInStoreResult<readonly OrganizationAuditRow[]>>;
}

/** Intent and outcome are independent immutable rows. Reading never attempts to settle a missing outcome. */
export function createOrganizationChangeAudit(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'clock'>;
}): OrganizationPeopleAudit {
	async function read(
		change: OrganizationPeopleChange,
	): Promise<SignInStoreResult<readonly OrganizationAuditRow[]>> {
		return readStoreValue(
			async () =>
				props
					.openDatabase()
					.select({
						id: signInAudit.id,
						requestId: signInAudit.requestId,
						actorUserId: signInAudit.actorUserId,
						organizationId: signInAudit.organizationId,
						change: signInAudit.changeKind,
						targetId: signInAudit.targetId,
						phase: signInAudit.phase,
						at: signInAudit.at,
					})
					.from(signInAudit)
					.where(
						and(
							eq(signInAudit.kind, 'organization-people-changed'),
							eq(signInAudit.requestId, change.requestId),
							eq(signInAudit.organizationId, change.organizationId),
						),
					),
			z.array(organizationAuditRowSchema),
		);
	}
	return {
		read,
		async record(
			change: OrganizationPeopleChange,
			phase: OrganizationChangePhase,
		): Promise<SignInStoreResult<void>> {
			const parsed = organizationPeopleChangeSchema.safeParse(change);
			if (!parsed.success) return { kind: 'store-unavailable', reason: 'row-unparseable' };
			const id = organizationChangeRecordId(parsed.data, phase);
			try {
				await props
					.openDatabase()
					.insert(signInAudit)
					.values({
						id,
						kind: 'organization-people-changed',
						requestId: change.requestId,
						actorUserId: change.actorUserId,
						organizationId: change.organizationId,
						phase,
						changeKind: change.change,
						targetId: change.targetId,
						at: props.platform.clock.now(),
					})
					.onConflictDoNothing()
					.returning({ id: signInAudit.id });
				const recorded = await read(change);
				if (recorded.kind === 'store-unavailable') return recorded;
				const matching = recorded.value.find((row) => row.id === id);
				if (
					matching === undefined ||
					matching.actorUserId !== change.actorUserId ||
					matching.change !== change.change ||
					matching.targetId !== change.targetId ||
					matching.phase !== phase
				)
					return { kind: 'store-unavailable', reason: 'row-unparseable' };
				return availableStoreValue(undefined);
			} catch (error) {
				return storeFailure(error);
			}
		},
	};
}
