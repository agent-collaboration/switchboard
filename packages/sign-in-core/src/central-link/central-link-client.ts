import {
	createAuthorizationRevisionPushClient,
	type AuthorizationRevisionPushClient,
} from '#sign-in-core/central-link/authorization-revision-push-client';
import type { CentralTransport } from '#sign-in-core/central-link/central-transport';
import {
	createFleetAdminLinkClient,
	type FleetAdminLinkClient,
} from '#sign-in-core/central-link/fleet-admin-client';
import { createOrganizationProvisioningClient } from '#sign-in-core/central-link/organization-provisioning-client';
import type { OrganizationProvisioningClient } from '#sign-in-core/organizations/organization-provisioning';

/** Every operation the sign-in service sends over its one private link to central. */
export type CentralLinkClient = OrganizationProvisioningClient &
	AuthorizationRevisionPushClient &
	FleetAdminLinkClient;

export function createCentralLinkClient(transport: CentralTransport): CentralLinkClient {
	return {
		...createOrganizationProvisioningClient(transport),
		...createAuthorizationRevisionPushClient(transport),
		...createFleetAdminLinkClient(transport),
	};
}
