import { APIError } from 'better-auth/api';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { z } from 'zod';

const offeredOrganizationRoleSchema = z.enum(['owner', 'member']);
type OrganizationRoleHooks = Required<
	Pick<
		NonNullable<OrganizationOptions['organizationHooks']>,
		'beforeAddMember' | 'beforeUpdateMemberRole' | 'beforeCreateInvitation' | 'beforeRemoveMember'
	>
>;

function requireOfferedOrganizationRole(role: unknown): 'owner' | 'member' {
	const result = offeredOrganizationRoleSchema.safeParse(role);
	if (!result.success)
		throw new APIError('FORBIDDEN', { message: 'organization-role-not-allowed' });
	return result.data;
}

/** Native plugin hooks protect the configured role surface independently of change recording. */
export function createOrganizationRoleHooks(): OrganizationRoleHooks {
	return {
		async beforeAddMember(data: { readonly member: { readonly role: string } }): Promise<void> {
			requireOfferedOrganizationRole(data.member.role);
		},
		async beforeUpdateMemberRole(data: { readonly newRole: string }): Promise<void> {
			requireOfferedOrganizationRole(data.newRole);
		},
		async beforeCreateInvitation(data: {
			readonly invitation: { readonly role: string };
		}): Promise<void> {
			if (requireOfferedOrganizationRole(data.invitation.role) !== 'member')
				throw new APIError('FORBIDDEN', { message: 'owner-invitation-not-allowed' });
		},
		async beforeRemoveMember(data: { readonly member: { readonly role: string } }): Promise<void> {
			if (requireOfferedOrganizationRole(data.member.role) === 'owner')
				throw new APIError('FORBIDDEN', { message: 'owner-removal-not-allowed' });
		},
	};
}
