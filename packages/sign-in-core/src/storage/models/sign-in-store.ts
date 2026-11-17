import type { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import type { OrganizationStampRecords } from '#sign-in-core/organizations/organization-stamp-renewal';
import type { FactorChangeRecords } from '#sign-in-core/second-factors/factor-change-record';
import type { PasskeyCredentialRecords } from '#sign-in-core/second-factors/passkey-credential-records';
import type { SecondFactorRecords } from '#sign-in-core/second-factors/second-factor-session';
import type { AgentRegistrationRecords } from '#sign-in-core/storage/agent-registration-store';
import type { AuthorizationRevisionDeliveryRecords } from '#sign-in-core/storage/authorization-revision-delivery-store';
import type { LinkedLoginAuditRecords } from '#sign-in-core/storage/linked-login-audit';
import type { PersonSessionRecords } from '#sign-in-core/storage/models/person-session-records';
import type { OrganizationPeopleAudit } from '#sign-in-core/storage/organization-change-audit';
import type { OrganizationMembershipRecords } from '#sign-in-core/storage/organization-membership-store';
import type { OwnerBootstrapRecords } from '#sign-in-core/storage/owner-bootstrap-store';
import type { PersonFleetAuthorizationRecords } from '#sign-in-core/storage/person-fleet-authorization-store';
import type { WorkspaceManagementRecords } from '#sign-in-core/storage/workspace-management-audit';
import type { WorkspaceResourceRecords } from '#sign-in-core/storage/workspace-resource-store';

export const personIdSchema = uuid7Schema.brand<'PersonId'>();
export const organizationIdSchema = uuid7Schema.brand<'OrganizationId'>();
export type PersonId = z.infer<typeof personIdSchema>;
export type OrganizationId = z.infer<typeof organizationIdSchema>;

export interface SignInStore {
	readonly authorizations: PersonFleetAuthorizationRecords;
	readonly revisionDelivery: AuthorizationRevisionDeliveryRecords;
	readonly passkeys: PasskeyCredentialRecords;
	readonly factorChanges: FactorChangeRecords;
	readonly factors: SecondFactorRecords;
	readonly organizations: OrganizationMembershipRecords;
	readonly organizationStamps: OrganizationStampRecords;
	readonly peopleChanges: OrganizationPeopleAudit;
	readonly linkedLogins: LinkedLoginAuditRecords;
	readonly persons: PersonSessionRecords;
	readonly agents: AgentRegistrationRecords;
	readonly resources: WorkspaceResourceRecords;
	readonly audit: WorkspaceManagementRecords;
	readonly bootstrap: OwnerBootstrapRecords;
}
