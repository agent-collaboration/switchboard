import { expect, it } from 'vitest';

import { createControlledCentralProvisioning } from '#sign-in-test-support/test-fixtures/controlled-central-provisioning';

it('counts all peer arrivals before rejecting wrong methods, paths, bodies and authorization', async (): Promise<void> => {
	const peer = createControlledCentralProvisioning();
	const probes = [
		new Request('http://central.invalid/forbidden-probe', { method: 'POST', body: '{}' }),
		new Request('http://central.invalid/internal/organization-provisioning', {
			method: 'POST',
			body: '{}',
		}),
		new Request('http://central.invalid/internal/organization-provisioning', {
			method: 'POST',
			headers: { authorization: 'Bearer controlled-proof' },
			body: JSON.stringify({ organizationId: '019a3dce-2000-7000-8000-000000000001' }),
		}),
		new Request('http://central.invalid/internal/organization-provisioning'),
	];
	const responses = await Promise.all(
		probes.map((probe: Request): Promise<Response> => peer.fetch(probe)),
	);
	for (const response of responses) expect(response.ok).toBe(false);
	expect(peer.sends).toEqual([]);
	expect(peer.arrivals).toEqual([
		{ method: 'POST', path: 'other', hasAuthorization: false },
		{ method: 'POST', path: '/internal/organization-provisioning', hasAuthorization: false },
		{ method: 'POST', path: '/internal/organization-provisioning', hasAuthorization: true },
		{ method: 'other', path: '/internal/organization-provisioning', hasAuthorization: false },
	]);
	// No header value, arbitrary URL, body or token reaches the observation.
	expect(JSON.stringify(peer.arrivals)).not.toContain('controlled-proof');
});

it('answers the digest read only from a held stamp and maps each scripted refusal to central status', async (): Promise<void> => {
	// Arrange
	const peer = createControlledCentralProvisioning();
	const organizationId = '019a3dce-2000-7000-8000-000000000001';
	const digestRead = (): Request =>
		new Request('http://central.invalid/internal/organization-statement-digest', {
			method: 'POST',
			body: JSON.stringify({ organizationId }),
		});
	const provision = (): Request =>
		new Request('http://central.invalid/internal/organization-provisioning', {
			method: 'POST',
			body: JSON.stringify({ organizationId, organizationStatement: 'aa.bb.cc' }),
		});
	// Act / Assert: no stamp held is central's unprovisioned 404.
	expect((await peer.fetch(digestRead())).status).toBe(404);
	const stamp = { digest: 'd'.repeat(64), expiresAt: 1, signingKeyId: 'kid' };
	peer.holdStamp(organizationId, stamp);
	expect(await (await peer.fetch(digestRead())).json()).toEqual(stamp);
	expect(peer.digestReads).toEqual([organizationId, organizationId]);
	const statuses: number[] = [];
	for (const mode of [
		'organization-mismatch',
		'stale',
		'invalid-statement',
		'unavailable',
	] as const) {
		peer.replyWith(mode);
		statuses.push((await peer.fetch(provision())).status);
	}
	expect(statuses).toEqual([403, 409, 422, 503]);
	expect(peer.sends).toHaveLength(4);
});

it('retains accepted request bodies exactly and distinguishes replies from lost replies', async (): Promise<void> => {
	// Arrange: spacing differs from JSON.stringify, so reserializing would fail the byte comparison.
	const peer = createControlledCentralProvisioning();
	const requestBody =
		'{ "organizationStatement" : "aa.bb.cc", "organizationId" : "019a3dce-2000-7000-8000-000000000001" }';
	const request = (): Request =>
		new Request('http://central.invalid/internal/organization-provisioning', {
			method: 'POST',
			body: requestBody,
		});
	peer.replyWith('invalid-statement');
	// Act
	await peer.fetch(request());
	peer.replyWith('lost-reply');
	await expect(peer.fetch(request())).rejects.toThrow('reply lost');
	// Assert: only the allowed body and reply cross the evidence boundary, never header values.
	expect(peer.exchanges).toEqual([
		{
			path: '/internal/organization-provisioning',
			requestBody,
			response: { kind: 'answered', status: 422, body: '' },
		},
		{ path: '/internal/organization-provisioning', requestBody, response: { kind: 'lost-reply' } },
	]);
});

it('retains revision push bytes and the peer ACK or lost-reply marker', async (): Promise<void> => {
	const peer = createControlledCentralProvisioning();
	const requestBody =
		'{ "kind":"organization", "organizationId":"019a3dce-2000-7000-8000-000000000001", "revision":1, "state":"active", "permissionPolicyDigest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }';
	const request = (): Request =>
		new Request('http://central.invalid/internal/organization-authorization-revisions', {
			method: 'POST',
			body: requestBody,
		});
	expect((await peer.fetch(request())).status).toBe(200);
	peer.replyToPushesWith('lost-reply');
	await expect(peer.fetch(request())).rejects.toThrow('ACK lost');
	expect(peer.exchanges).toEqual([
		{
			path: '/internal/organization-authorization-revisions',
			requestBody,
			response: { kind: 'answered', status: 200, body: '{"acknowledgedRevision":1}' },
		},
		{
			path: '/internal/organization-authorization-revisions',
			requestBody,
			response: { kind: 'lost-reply' },
		},
	]);
});
