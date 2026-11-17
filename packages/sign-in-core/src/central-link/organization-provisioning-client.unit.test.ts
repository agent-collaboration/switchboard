import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	centralProvisioningReplySchema,
	centralProvisioningRequestSchema,
	createOrganizationProvisioningClient,
} from '#sign-in-core/central-link/organization-provisioning-client';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const organizationId = organizationIdSchema.parse('019a3dce-2000-7000-8000-000000000001');
const organizationStatement = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJvcmcifQ.c2lnbmF0dXJl';
const digest = 'ab'.repeat(32);

/** A transport that records each private send and answers from a scripted reply. */
function scriptedTransport(reply: () => Promise<Response>): {
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

describe('producer-owned provisioning contract', (): void => {
	it.each([
		{ name: 'ProvisionOrganization', schema: centralProvisioningRequestSchema },
		{ name: 'ProvisionOrganizationResult', schema: centralProvisioningReplySchema },
	])(
		'accepts $name producer examples and refuses its retired and malformed variants',
		async ({ name, schema }): Promise<void> => {
			const fixtures = new URL(
				`../../contract-fixtures/central-provisioning/${name}.fixtures.json`,
				import.meta.url,
			);
			const negatives = new URL(
				`../../contract-fixtures/central-provisioning/${name}.negatives.json`,
				import.meta.url,
			);
			for (const value of z.array(z.unknown()).parse(JSON.parse(await readFile(fixtures, 'utf8'))))
				expect(schema.safeParse(value).success).toBe(true);
			for (const value of z.array(z.unknown()).parse(JSON.parse(await readFile(negatives, 'utf8'))))
				expect(schema.safeParse(value).success).toBe(false);
		},
	);

	it('refuses the retired organizationId-only body', (): void => {
		expect(centralProvisioningRequestSchema.safeParse({ organizationId }).success).toBe(false);
	});

	it('sends the signed statement in one exact private-link call and confirms only the closed reply', async (): Promise<void> => {
		// Arrange: the peer stands in for central's behaviour, not for our parser or send.
		const transport = scriptedTransport(async () => Response.json({ result: 'provisioned' }));
		const client = createOrganizationProvisioningClient(transport);
		// Act
		const result = await client.provisionOrganization({ organizationId, organizationStatement });
		// Assert
		expect(result).toEqual({ kind: 'provisioned' });
		expect(transport.sent).toHaveLength(1);
		const request = transport.sent[0];
		if (request === undefined) throw new Error('No provisioning request was sent');
		expect(request.method).toBe('POST');
		expect(new URL(request.url).pathname).toBe('/internal/organization-provisioning');
		expect(request.headers.get('content-type')).toBe('application/json');
		expect(request.headers.has('authorization')).toBe(false);
		expect(await request.json()).toEqual({ organizationId, organizationStatement });
	});

	it.each([
		{ status: 403, expected: { kind: 'refused', reason: 'organization-mismatch' } },
		{ status: 409, expected: { kind: 'refused', reason: 'stale' } },
		{ status: 422, expected: { kind: 'refused', reason: 'invalid-statement' } },
		{ status: 400, expected: { kind: 'unknown', reason: 'unavailable' } },
		{ status: 503, expected: { kind: 'unknown', reason: 'unavailable' } },
		{ status: 201, expected: { kind: 'unknown', reason: 'unavailable' } },
	])(
		'maps central status $status to its own outcome after exactly one send, ignoring any body',
		async ({ status, expected }): Promise<void> => {
			// Arrange: even a success-shaped body on an error status confirms nothing.
			const transport = scriptedTransport(
				async () => new Response('{"result":"provisioned"}', { status }),
			);
			// Act
			const result = await createOrganizationProvisioningClient(transport).provisionOrganization({
				organizationId,
				organizationStatement,
			});
			// Assert
			expect(result).toEqual(expected);
			expect(transport.sent).toHaveLength(1);
		},
	);

	it.each(['{"result":"provisioned","unexpectedField":true}', '{"result":"admitted"}', 'not-json'])(
		'keeps a 200 with body %s unknown as a malformed reply',
		async (body): Promise<void> => {
			const transport = scriptedTransport(async () => new Response(body, { status: 200 }));
			await expect(
				createOrganizationProvisioningClient(transport).provisionOrganization({
					organizationId,
					organizationStatement,
				}),
			).resolves.toEqual({ kind: 'unknown', reason: 'malformed-reply' });
		},
	);

	it('keeps a lost reply unknown and sends only on the next explicit invocation', async (): Promise<void> => {
		let loseReply = true;
		const transport = scriptedTransport(async () => {
			if (loseReply) throw new Error('Reply lost after the peer received the request');
			return Response.json({ result: 'provisioned' });
		});
		const client = createOrganizationProvisioningClient(transport);
		await expect(
			client.provisionOrganization({ organizationId, organizationStatement }),
		).resolves.toEqual({ kind: 'unknown', reason: 'unavailable' });
		loseReply = false;
		await expect(
			client.provisionOrganization({ organizationId, organizationStatement }),
		).resolves.toEqual({ kind: 'provisioned' });
		expect(transport.sent).toHaveLength(2);
	});

	it('refuses to send a statement that is not a bounded compact JWS', async (): Promise<void> => {
		const transport = scriptedTransport(async () => Response.json({ result: 'provisioned' }));
		const client = createOrganizationProvisioningClient(transport);
		await expect(
			client.provisionOrganization({ organizationId, organizationStatement: 'not.a-jws' }),
		).rejects.toThrow();
		expect(transport.sent).toHaveLength(0);
	});
});

describe('private statement digest read', (): void => {
	it('reads central verified digest, expiry and key in one exact call naming only the organization', async (): Promise<void> => {
		// Arrange
		const transport = scriptedTransport(async () =>
			Response.json({ digest, expiresAt: 2_000_000_000, signingKeyId: 'native-key-1' }),
		);
		// Act
		const result =
			await createOrganizationProvisioningClient(transport).readStatementDigest(organizationId);
		// Assert
		expect(result).toEqual({
			kind: 'current',
			digest,
			expiresAt: 2_000_000_000,
			signingKeyId: 'native-key-1',
		});
		const request = transport.sent[0];
		if (request === undefined) throw new Error('No digest read was sent');
		expect(transport.sent).toHaveLength(1);
		expect(request.method).toBe('POST');
		expect(new URL(request.url).pathname).toBe('/internal/organization-statement-digest');
		expect(request.headers.has('authorization')).toBe(false);
		expect(await request.json()).toEqual({ organizationId });
	});

	it('reads 404 as an unprovisioned store', async (): Promise<void> => {
		const transport = scriptedTransport(async () => new Response(null, { status: 404 }));
		await expect(
			createOrganizationProvisioningClient(transport).readStatementDigest(organizationId),
		).resolves.toEqual({ kind: 'none' });
	});

	it.each([
		{ body: { digest }, reason: 'malformed-reply' },
		{
			body: { digest: 'AB'.repeat(32), expiresAt: 1, signingKeyId: 'k' },
			reason: 'malformed-reply',
		},
		{ body: { digest, expiresAt: 1.5, signingKeyId: 'k' }, reason: 'malformed-reply' },
		{ body: { digest, expiresAt: 1, signingKeyId: '' }, reason: 'malformed-reply' },
		{
			body: { digest, expiresAt: 1, signingKeyId: 'k', statement: 'a.b.c' },
			reason: 'malformed-reply',
		},
	])('refuses a reply outside the closed tuple: $body', async ({ body, reason }): Promise<void> => {
		const transport = scriptedTransport(async () => Response.json(body));
		await expect(
			createOrganizationProvisioningClient(transport).readStatementDigest(organizationId),
		).resolves.toEqual({ kind: 'unavailable', reason });
	});

	it.each([409, 503])('reads status %i as unavailable', async (status): Promise<void> => {
		const transport = scriptedTransport(async () => new Response(null, { status }));
		await expect(
			createOrganizationProvisioningClient(transport).readStatementDigest(organizationId),
		).resolves.toEqual({ kind: 'unavailable', reason: 'unavailable' });
	});
});
