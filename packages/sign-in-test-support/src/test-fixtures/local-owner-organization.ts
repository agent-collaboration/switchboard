import { invitation, member, user, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

/** Test procedure only: the configured owner signs in before native organization creation. */
export async function ensureLocalOwnerOrganization(props: {
	readonly auth: (pathname: string, init?: RequestInit) => Promise<Response>;
	readonly database: SignInDatabase;
}): Promise<string> {
	const rows = await props.database
		.select({ organizationId: member.organizationId })
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(and(eq(user.email, 'owner@example.invalid'), eq(member.role, 'owner')));
	const first = rows[0];
	if (first !== undefined) return z.uuidv7().parse(first.organizationId);
	const created = await props.auth('/api/auth/organization/create', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'Owner organization', slug: 'owner-organization' }),
	});
	if (!created.ok) throw new Error('Real owner organization creation refused');
	return z.object({ id: z.uuidv7() }).parse(await created.json()).id;
}
export async function inviteLocalPerson(props: {
	readonly auth: (pathname: string, init?: RequestInit) => Promise<Response>;
	readonly database: SignInDatabase;
	readonly email: string;
}): Promise<string> {
	const organizationId = await ensureLocalOwnerOrganization(props);
	const invited = await props.auth('/api/auth/organization/invite-member', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email: props.email, organizationId, role: 'member' }),
	});
	if (!invited.ok) throw new Error('Real member invitation refused');
	return z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
}
export async function acceptLocalInvitations(props: {
	readonly auth: (pathname: string, init?: RequestInit) => Promise<Response>;
	readonly database: SignInDatabase;
	readonly email: string;
}): Promise<void> {
	const rows = await props.database
		.select({ id: invitation.id })
		.from(invitation)
		.where(and(eq(invitation.email, props.email), eq(invitation.status, 'pending')));
	if (rows.length > 1) throw new Error('Legacy CLI fixture expects at most one pending invitation');
	const pending = rows[0];
	if (pending === undefined) return;
	const accepted = await props.auth('/api/auth/organization/accept-invitation', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ invitationId: pending.id }),
	});
	if (!accepted.ok) throw new Error('Real member acceptance refused');
}
