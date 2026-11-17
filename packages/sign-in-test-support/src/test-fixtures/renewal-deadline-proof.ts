import { expect } from 'vitest';

import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

/**
 * D7 proof control on either proof host: while a barrier prefix is set, each proof drain, guard
 * run or relay holds its renewal send at the `hold` barrier `<prefix>:<organizationId>` and fires
 * its own request-local deadline only once released.
 */
export async function setRenewalDeadlineBarrier(
	harness: Harness,
	barrierPrefix: string | null,
): Promise<void> {
	const response = await harness.auth('/__auth-proof/renewal-deadline', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ barrierPrefix }),
	});
	expect(response.status).toBe(200);
}

export async function armRenewalDeadline(
	harness: Harness,
	prefix: string,
	organizationId: string,
): Promise<void> {
	const response = await harness.auth(`/__auth-proof/hold/arm?key=${prefix}:${organizationId}`, {
		method: 'POST',
	});
	expect(response.status).toBe(200);
}

/**
 * Waits until central holds the `count`th renewal send unanswered and the request waits at that
 * organization's barrier, then releases it: only now does that request's deadline fire.
 */
export async function fireDeadlineAfterCentralHolds(
	harness: Harness,
	prefix: string,
	count: number,
): Promise<string> {
	await harness.centralProvisioning.waitForHeld(count);
	const organizationId = harness.centralProvisioning.sends.at(-1)?.organizationId ?? '';
	const key = `${prefix}:${organizationId}`;
	expect((await harness.auth(`/__auth-proof/hold/entered?key=${key}`)).status).toBe(200);
	expect(
		(await harness.auth(`/__auth-proof/hold/release?key=${key}`, { method: 'POST' })).status,
	).toBe(200);
	return organizationId;
}

/**
 * WS7 R-retrysignal proof control: while set, an admin retry (the only admin send with a signal)
 * waits at `<prefix>:<organizationId>` and fires its own deadline once released. Setting it
 * clears earlier observations.
 */
export async function setRetryDeadlineBarrier(
	harness: Harness,
	barrierPrefix: string | null,
): Promise<void> {
	const response = await harness.auth('/__auth-proof/retry-deadline', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ barrierPrefix }),
	});
	expect(response.status).toBe(200);
}

/** Waits until central holds the retry and the request waits at its barrier, then releases it. */
export async function fireRetryDeadlineAfterCentralHolds(
	harness: Harness,
	prefix: string,
	organizationId: string,
): Promise<void> {
	await harness.centralProvisioning.waitForHeldAdmin();
	const key = `${prefix}:${organizationId}`;
	expect((await harness.auth(`/__auth-proof/hold/entered?key=${key}`)).status).toBe(200);
	expect(
		(await harness.auth(`/__auth-proof/hold/release?key=${key}`, { method: 'POST' })).status,
	).toBe(200);
}

/** Each admin send the real client made while the retry barrier was set, and its signal. */
export async function retrySignalObservations(harness: Harness): Promise<unknown> {
	const response = await harness.auth('/__auth-proof/retry-signal');
	expect(response.status).toBe(200);
	return response.json();
}
