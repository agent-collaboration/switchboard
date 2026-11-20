import { organizationIdSchema } from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

export const organizationReadProbeHeader = 'x-auth-proof-organization-read';
export const organizationReadProbeSchema = z.strictObject({
	kind: z.enum(['lookup', 'list']),
	organizationId: organizationIdSchema,
	key: z.string().min(1),
});
export type OrganizationReadProbe = z.infer<typeof organizationReadProbeSchema>;

export function readOrganizationReadProbe(request: Request): OrganizationReadProbe | null {
	const path = new URL(request.url).pathname;
	if (
		path !== '/api/auth/organization/person-membership' &&
		path !== '/api/auth/organization/people-list'
	)
		return null;
	const header = request.headers.get(organizationReadProbeHeader);
	if (header === null) return null;
	const probe = organizationReadProbeSchema.parse(JSON.parse(header));
	return (probe.kind === 'lookup' && path.endsWith('/person-membership')) ||
		(probe.kind === 'list' && path.endsWith('/people-list'))
		? probe
		: null;
}
