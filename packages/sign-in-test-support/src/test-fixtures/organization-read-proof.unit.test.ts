import { describe, expect, it } from 'vitest';

import {
	matchesDatabaseFault,
	organizationReadProjection,
	type PreparedDriverCall,
} from '#sign-in-test-support/test-fixtures/database-fault-identity';
import { readOrganizationReadProbe } from '#sign-in-test-support/test-fixtures/organization-read-proof';

const organizationId = '11111111-1111-7111-8111-111111111111';
const examples = [
	[
		'membership-facts',
		'select "member"."role" from "member" inner join "user" on "member"."userId" = "user"."id" where "member"."organizationId" = ?',
	],
	[
		'membership-invitations',
		'select "id", "status", "expiresAt" from "invitation" where "organizationId" = ?',
	],
	[
		'people-members',
		'select "user"."name", "user"."email", "member"."role" from "member" inner join "user" on "member"."userId" = "user"."id" where "member"."organizationId" = ? order by "member"."createdAt" asc, "member"."id" asc limit ?',
	],
	['people-count', 'select count(*) from "member" where "member"."organizationId" = ?'],
	[
		'people-invitations',
		'select "id", "status", "expiresAt", "email", "role" from "invitation" where "organizationId" = ?',
	],
	[
		'memberships',
		'select "member"."organizationId", "organization"."name", "member"."userId", "member"."role" from "member" inner join "organization" on "member"."organizationId" = "organization"."id"',
	],
] as const;

describe('organization read proof controls', () => {
	it.each(examples)(
		'distinguishes the %s projection from every other select',
		(projection, query): void => {
			const call = { query, parameters: [organizationId] } satisfies PreparedDriverCall;
			expect(organizationReadProjection(call)).toBe(projection);
			for (const [otherProjection] of examples)
				expect(
					matchesDatabaseFault(call, {
						operation: 'select',
						table: query.includes('from "invitation"') ? 'invitation' : 'member',
						key: organizationId,
						additionalKeys: [],
						projection: otherProjection,
					}),
				).toBe(otherProjection === projection);
			expect(
				matchesDatabaseFault(call, {
					operation: 'select',
					table: 'member',
					key: 'different-organization',
					additionalKeys: [],
					projection,
				}),
			).toBe(false);
		},
	);

	it('leaves native role checks outside subject-read counts and accepts only matching hold paths', (): void => {
		expect(
			organizationReadProjection({
				query: 'select "role" from "member" where "userId" = ?',
				parameters: [organizationId],
			}),
		).toBeNull();
		for (const [kind, path] of [
			['lookup', 'person-membership'],
			['list', 'people-list'],
		] as const) {
			const probe = { kind, organizationId, key: 'named-proof-hold' };
			const headers = { 'x-auth-proof-organization-read': JSON.stringify(probe) };
			expect(
				readOrganizationReadProbe(
					new Request(`https://auth.invalid/api/auth/organization/${path}`, { headers }),
				),
			).toEqual(probe);
			expect(
				readOrganizationReadProbe(
					new Request('https://auth.invalid/api/auth/organization/set-active', { headers }),
				),
			).toBeNull();
		}
	});
});
