import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	authorizationRevisionAcknowledgementSchema,
	authorizationRevisionPushSchema,
	createAuthorizationRevisionPushClient,
	type AuthorizationRevisionPush,
} from '#sign-in-core/central-link/authorization-revision-push-client';

const organizationPush: AuthorizationRevisionPush = {
	kind: 'organization',
	organizationId: '019a3dce-2000-7000-8000-000000000001',
	revision: 3,
	state: 'stopped',
	permissionPolicyDigest: 'd'.repeat(64),
};
const personPush: AuthorizationRevisionPush = {
	kind: 'person',
	organizationId: '019a3dce-2000-7000-8000-000000000001',
	personId: '019a3dce-2000-7000-8000-000000000002',
	subjectId: '019a3dce-2000-7000-8000-000000000003',
	revision: 7,
	state: 'inactive',
};

function scripted(reply: () => Promise<Response>): {
	readonly sent: Request[];
	readonly fetch: (request: Request) => Promise<Response>;
} {
	const sent: Request[] = [];
	return {
		sent,
		fetch: async (request: Request): Promise<Response> => {
			sent.push(request);
			return reply();
		},
	};
}

describe('authorization revision push over the private link', (): void => {
	it.each([organizationPush, personPush])(
		'sends exactly the agreed $kind body, once, with no credential',
		async (push): Promise<void> => {
			// Arrange: the shapes agreed with central.
			const transport = scripted(async () =>
				Response.json({ acknowledgedRevision: push.revision }),
			);
			// Act
			const answer =
				await createAuthorizationRevisionPushClient(transport).pushAuthorizationRevision(push);
			// Assert
			expect(answer).toEqual({ kind: 'acknowledged', acknowledgedRevision: push.revision });
			const request = transport.sent[0];
			if (request === undefined) throw new Error('No push sent');
			expect(transport.sent).toHaveLength(1);
			expect(request.method).toBe('POST');
			expect(new URL(request.url).pathname).toBe('/internal/organization-authorization-revisions');
			expect(request.headers.has('authorization')).toBe(false);
			expect(await request.json()).toEqual(push);
		},
	);

	it('passes on a retained floor above the sent revision for the drainer to judge', async (): Promise<void> => {
		const transport = scripted(async () => Response.json({ acknowledgedRevision: 9 }));
		await expect(
			createAuthorizationRevisionPushClient(transport).pushAuthorizationRevision(personPush),
		).resolves.toEqual({ kind: 'acknowledged', acknowledgedRevision: 9 });
	});

	it.each([
		{ status: 403, expected: { kind: 'refused', reason: 'organization-mismatch' } },
		{ status: 409, expected: { kind: 'refused', reason: 'conflict' } },
		{ status: 412, expected: { kind: 'refused', reason: 'organization-floor-missing' } },
		// WS7 R-push503: only central's own 503 is kept apart; any other status stays unknown.
		{ status: 503, expected: { kind: 'answered-unavailable' } },
		{ status: 500, expected: { kind: 'unknown', reason: 'unavailable' } },
		{ status: 400, expected: { kind: 'unknown', reason: 'unavailable' } },
	])(
		'maps status $status to its own outcome, ignoring any body',
		async ({ status, expected }): Promise<void> => {
			const transport = scripted(
				async () => new Response('{"acknowledgedRevision":7}', { status }),
			);
			await expect(
				createAuthorizationRevisionPushClient(transport).pushAuthorizationRevision(personPush),
			).resolves.toEqual(expected);
		},
	);

	it.each(['{"acknowledgedRevision":0}', '{"acknowledgedRevision":7,"extra":1}', '{}', 'not-json'])(
		'never treats a malformed 200 (%s) as an ACK',
		async (body): Promise<void> => {
			const transport = scripted(async () => new Response(body, { status: 200 }));
			await expect(
				createAuthorizationRevisionPushClient(transport).pushAuthorizationRevision(personPush),
			).resolves.toEqual({ kind: 'unknown', reason: 'malformed-reply' });
		},
	);

	it('keeps a lost reply unknown', async (): Promise<void> => {
		const transport = scripted(async () => {
			throw new Error('Reply lost after central received the push');
		});
		await expect(
			createAuthorizationRevisionPushClient(transport).pushAuthorizationRevision(personPush),
		).resolves.toEqual({ kind: 'unknown', reason: 'unavailable' });
	});
});

describe('producer-owned authorization revision contract', (): void => {
	it.each([
		{ name: 'AuthorizationRevision', schema: authorizationRevisionPushSchema },
		{
			name: 'AuthorizationRevisionAcknowledgement',
			schema: authorizationRevisionAcknowledgementSchema,
		},
	])(
		'accepts $name producer examples and refuses its negatives',
		async ({ name, schema }): Promise<void> => {
			const read = async (kind: 'fixtures' | 'negatives'): Promise<readonly unknown[]> =>
				z
					.array(z.unknown())
					.parse(
						JSON.parse(
							await readFile(
								new URL(
									`../../contract-fixtures/central-authorization-revisions/${name}.${kind}.json`,
									import.meta.url,
								),
								'utf8',
							),
						),
					);
			for (const value of await read('fixtures'))
				expect(schema.safeParse(value).success).toBe(true);
			for (const value of await read('negatives'))
				expect(schema.safeParse(value).success).toBe(false);
		},
	);
});
