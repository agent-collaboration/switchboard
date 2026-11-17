import type { GenericEndpointContext } from '@better-auth/core';
import { APIError, getSession } from 'better-auth/api';

import type { ReadSession } from '#sign-in-core/organizations/person-organization-context';
import { liveOwnerSessionSchema } from '#sign-in-core/storage/models/person-session-records';

/** Reads the hook's result, including null, without acquiring another session. */
export function readStoredOrganizationSession(value: unknown): ReadSession {
	if (value === null) return { kind: 'signed-out' };
	const parsed = liveOwnerSessionSchema.safeParse(value);
	if (!parsed.success) return { kind: 'unavailable' };
	return parsed.data.user.emailVerified
		? { kind: 'session', value: parsed.data }
		: { kind: 'signed-out' };
}

/** Native getSession preserves adapter errors; getSessionFromCtx would hide them. */
export async function acquireReadSession(context: GenericEndpointContext): Promise<ReadSession> {
	try {
		const acquired = await getSession()({
			...context,
			params: context.params ?? {},
			method: 'GET',
			asResponse: false,
			headers: context.headers ?? new Headers(),
			returnHeaders: true,
			returnStatus: false,
			query: { disableCookieCache: true, disableRefresh: true },
		});
		for (const cookie of acquired.headers.getSetCookie())
			context.responseHeaders.append('set-cookie', cookie);
		return readStoredOrganizationSession(acquired.response);
	} catch (error) {
		return error instanceof APIError && error.status === 'UNAUTHORIZED'
			? { kind: 'signed-out' }
			: { kind: 'unavailable' };
	}
}

export function isOrganizationMembershipReadPath(path: string | undefined): boolean {
	return (
		path !== undefined &&
		[
			'/organization/self-context',
			'/organization/person-membership',
			'/organization/people-list',
			'/organization/people',
		].includes(path)
	);
}
