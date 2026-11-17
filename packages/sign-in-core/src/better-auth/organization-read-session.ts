import type { GenericEndpointContext } from '@better-auth/core';
import { APIError, getSession } from 'better-auth/api';

import type { ReadSession } from '#sign-in-core/organizations/person-organization-context';
import {
	liveOwnerSessionSchema,
	type LiveOwnerSession,
} from '#sign-in-core/storage/models/person-session-records';

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

/** Supplies the global hook's read result to the endpoint without another acquisition. */
export async function organizationReadSessionBeforeHook(context: GenericEndpointContext): Promise<{
	readonly context: { readonly context: { readonly session: LiveOwnerSession | null } };
}> {
	const read = await acquireReadSession(context);
	if (read.kind === 'unavailable')
		throw new APIError('SERVICE_UNAVAILABLE', { message: 'organization-read-unavailable' });
	// The native read may leave an expired session here; the hook merge ignores null values.
	const session = read.kind === 'session' ? read.value : null;
	context.context.session = session;
	return { context: { context: { session } } };
}

/** The endpoint owns a fresh header accumulator, so retain native hook cookie clearing. */
export function organizationReadResponseHeaders(context: GenericEndpointContext): void {
	const hookHeaders =
		'responseHeaders' in context.context ? context.context.responseHeaders : undefined;
	if (hookHeaders instanceof Headers)
		for (const cookie of hookHeaders.getSetCookie())
			context.responseHeaders.append('set-cookie', cookie);
	context.setHeader('cache-control', 'no-store');
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
