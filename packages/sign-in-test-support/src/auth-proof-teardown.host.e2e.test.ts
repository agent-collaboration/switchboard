import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	registrationRequestId,
	startLocalAuthHarness,
	workspaceOne,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';

useControlledSignInClock();

async function registerAgent(
	harness: Awaited<ReturnType<typeof startLocalAuthHarness>>,
	owner: string,
): Promise<Response> {
	return harness.gateway(`/management/workspaces/${workspaceOne}/agents`, {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
		body: JSON.stringify({ persona: 'operator', requestId: registrationRequestId }),
	});
}

it('teardown: an awaited Gateway request returns 200 before exact snapshot and real disposal', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const response = await registerAgent(harness, await harness.ownerToken());
		expect(response.status).toBe(200);
	} finally {
		await harness.close();
	}
	expect(harness.teardownObservations).toEqual([
		{ kind: 'harness-close', state: { kind: 'ready' } },
		{ kind: 'receipt-snapshot' },
		{ kind: 'dispose-start' },
		{ kind: 'dispose-ended' },
		{ kind: 'receipts-unchanged' },
		{ kind: 'http-cleanup-start' },
		{ kind: 'http-cleanup-ended' },
		{ kind: 'final-receipts-unchanged' },
	]);
});

it('teardown: a real held JWKS response reports pendingAtClose and keeps receipts unchanged through disposal', async () => {
	const harness = await startLocalAuthHarness();
	let closeStarted = false;
	let releaseHold: (() => void) | undefined;
	try {
		const owner = await harness.ownerToken();
		const hold = harness.httpResponseHolds.armNextJwksResponse();
		releaseHold = hold.release;
		const events: string[] = [];
		const realDispose = harness.miniflare.dispose.bind(harness.miniflare);
		harness.miniflare.dispose = async (): Promise<void> => {
			events.push('dispose-start');
			await realDispose();
			events.push('dispose-ended');
		};
		const streamSettled = hold.settled.then((outcome) => {
			const settlement = harness.teardownObservations.some(
				(event) => event.kind === 'http-cleanup-start',
			)
				? 'during-http-fixture-cleanup'
				: events.includes('dispose-ended')
					? 'after-dispose-before-http-cleanup'
					: 'before-dispose-ended';
			process.stderr.write(
				`${JSON.stringify({
					event: 'auth-proof-held-stream-settlement',
					settlement,
					workerdCancellation: 'unproven',
				})}\n`,
			);
			events.push(`stream-${outcome}`);
			return outcome;
		});
		const gatewayEnded = registerAgent(harness, owner).then(
			(response) => ({ kind: 'response', status: response.status }),
			() => ({ kind: 'error' }),
		);
		await hold.entered;
		closeStarted = true;
		await expect(harness.close()).rejects.toMatchObject({
			state: { kind: 'pendingAtClose', pendingRequests: 1 },
		});
		expect(harness.teardownObservations).toEqual([
			{ kind: 'harness-close', state: { kind: 'pendingAtClose', pendingRequests: 1 } },
			{ kind: 'receipt-snapshot' },
			{ kind: 'dispose-start' },
			{ kind: 'dispose-ended' },
			{ kind: 'receipts-unchanged' },
			{ kind: 'http-cleanup-start' },
			{ kind: 'http-cleanup-ended' },
			{ kind: 'final-receipts-unchanged' },
		]);
		expect(await streamSettled).toBe('closed');
		expect(events).toContain('dispose-start');
		expect(events).toContain('dispose-ended');
		expect(events).toContain('stream-closed');
		expect(events.indexOf('stream-closed')).toBeGreaterThan(events.indexOf('dispose-start'));
		await gatewayEnded;
	} finally {
		releaseHold?.();
		if (!closeStarted) await harness.close();
	}
});
