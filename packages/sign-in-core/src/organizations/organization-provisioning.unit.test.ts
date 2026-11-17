import { describe, expect, it } from 'vitest';

import type { OrganizationStatementSigningRequest } from '#sign-in-core/contracts/organization-statement';
import {
	ensureOrganizationProvisioned,
	type OrganizationFleetState,
	type OrganizationProvisioningClient,
	type OrganizationProvisioningStore,
	type ProvisionOrganizationAnswer,
} from '#sign-in-core/organizations/organization-provisioning';
import type {
	OrganizationStampFacts,
	OrganizationStampRecords,
} from '#sign-in-core/organizations/organization-stamp-renewal';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const organizationId = organizationIdSchema.parse('11111111-1111-7111-8111-111111111111');
const signedStatement = 'header.claims.signature';

function controlledStore(initial: OrganizationFleetState | null): {
	readonly store: OrganizationProvisioningStore;
	readonly readCurrent: () => OrganizationFleetState | null;
} {
	let current = initial;
	return {
		store: {
			readFleetState: async () => ({ kind: 'available', value: current }),
			markFleetReady: async () => {
				current = 'ready';
				return { kind: 'available', value: undefined };
			},
		},
		readCurrent: () => current,
	};
}

/** Records what setup asked the native signer for; the statement bytes are opaque here. */
function recordingSigner(): {
	readonly requests: OrganizationStatementSigningRequest[];
	readonly sign: (request: OrganizationStatementSigningRequest) => Promise<string>;
} {
	const requests: OrganizationStatementSigningRequest[] = [];
	return {
		requests,
		sign: async (request) => {
			requests.push(request);
			return signedStatement;
		},
	};
}

function answeringClient(answer: () => ProvisionOrganizationAnswer): {
	readonly calls: unknown[];
	readonly client: Pick<
		OrganizationProvisioningClient,
		'provisionOrganization' | 'readStatementDigest'
	>;
} {
	const calls: unknown[] = [];
	return {
		calls,
		client: {
			provisionOrganization: async (request): Promise<ProvisionOrganizationAnswer> => {
				calls.push(request);
				return answer();
			},
			readStatementDigest: async () => ({ kind: 'unavailable', reason: 'unavailable' }),
		},
	};
}

/** Setup's seed write; these cases leave central's digest read unavailable, so it never runs. */
const unusedStamps: Pick<OrganizationStampRecords, 'seedConfirmedStamp'> = {
	seedConfirmedStamp: async () => {
		throw new Error('No seed expected');
	},
};

describe('organization provisioning before forwarded Fleet work', () => {
	it('signs a setup statement without a predecessor and stays settingUp until Provisioned arrives', async () => {
		// Arrange: a contract stand-in holds central's answer; the local state transition is real.
		const state = controlledStore('settingUp');
		const signer = recordingSigner();
		const entered = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<ProvisionOrganizationAnswer>();
		const calls: unknown[] = [];
		const pending = ensureOrganizationProvisioned({
			organizationId,
			store: state.store,
			stamps: unusedStamps,
			signStatement: signer.sign,
			centralClient: {
				provisionOrganization: async (request): Promise<ProvisionOrganizationAnswer> => {
					calls.push(request);
					entered.resolve();
					return answer.promise;
				},
				readStatementDigest: async () => ({ kind: 'unavailable', reason: 'unavailable' }),
			},
		});
		// Act
		await entered.promise;
		// Assert
		expect(signer.requests).toEqual([{ organizationId }]);
		expect(calls).toEqual([{ organizationId, organizationStatement: signedStatement }]);
		expect(state.readCurrent()).toBe('settingUp');
		answer.resolve({ kind: 'provisioned' });
		await expect(pending).resolves.toEqual({ kind: 'ready' });
		expect(state.readCurrent()).toBe('ready');
	});

	it.each(['unavailable', 'timeout', 'malformed-reply'] as const)(
		'keeps unknown %s retryable, then resends a freshly signed statement for the same organization',
		async (reason) => {
			// Arrange
			const state = controlledStore('settingUp');
			const signer = recordingSigner();
			let confirmed = false;
			const central = answeringClient(() =>
				confirmed ? { kind: 'provisioned' } : { kind: 'unknown', reason },
			);
			const attempt = (): ReturnType<typeof ensureOrganizationProvisioned> =>
				ensureOrganizationProvisioned({
					organizationId,
					store: state.store,
					stamps: unusedStamps,
					centralClient: central.client,
					signStatement: signer.sign,
				});
			// Act / Assert
			await expect(attempt()).resolves.toEqual({ kind: 'setting-up', reason });
			expect(state.readCurrent()).toBe('settingUp');
			confirmed = true;
			await expect(attempt()).resolves.toEqual({ kind: 'ready' });
			expect(signer.requests).toEqual([{ organizationId }, { organizationId }]);
			expect(central.calls).toHaveLength(2);
		},
	);

	it.each(['organization-mismatch', 'invalid-statement', 'stale'] as const)(
		'a central refusal (%s) is reported as refused and never marks the organization ready',
		async (reason) => {
			// Arrange
			const state = controlledStore('settingUp');
			const central = answeringClient(() => ({ kind: 'refused', reason }));
			// Act
			const result = await ensureOrganizationProvisioned({
				organizationId,
				store: state.store,
				stamps: unusedStamps,
				centralClient: central.client,
				signStatement: recordingSigner().sign,
			});
			// Assert
			expect(result).toEqual({ kind: 'refused', reason });
			expect(state.readCurrent()).toBe('settingUp');
		},
	);

	it('a signing failure sends nothing and stays settingUp', async () => {
		// Arrange
		const state = controlledStore('settingUp');
		const central = answeringClient(() => ({ kind: 'provisioned' }));
		// Act
		const result = await ensureOrganizationProvisioned({
			organizationId,
			store: state.store,
			stamps: unusedStamps,
			centralClient: central.client,
			signStatement: async () => {
				throw new Error('Native signing key unavailable');
			},
		});
		// Assert
		expect(result).toEqual({ kind: 'setting-up', reason: 'signing-unavailable' });
		expect(central.calls).toEqual([]);
		expect(state.readCurrent()).toBe('settingUp');
	});

	it.each(['ready', null] as const)(
		'neither signs nor sends when stored state is %j',
		async (initial) => {
			// Arrange
			const state = controlledStore(initial);
			const signer = recordingSigner();
			const central = answeringClient(() => ({ kind: 'provisioned' }));
			// Act
			const result = await ensureOrganizationProvisioned({
				organizationId,
				store: state.store,
				stamps: unusedStamps,
				centralClient: central.client,
				signStatement: signer.sign,
			});
			// Assert
			expect(result).toEqual(initial === 'ready' ? { kind: 'ready' } : { kind: 'not-found' });
			expect(signer.requests).toEqual([]);
			expect(central.calls).toEqual([]);
		},
	);

	it('reports a failed local ready write and retries after central already provisioned', async () => {
		// Arrange
		const state = controlledStore('settingUp');
		let writesAvailable = false;
		const store: OrganizationProvisioningStore = {
			readFleetState: state.store.readFleetState,
			markFleetReady: async (id) =>
				writesAvailable
					? state.store.markFleetReady(id)
					: { kind: 'store-unavailable', reason: 'database-error' },
		};
		const central = answeringClient(() => ({ kind: 'provisioned' }));
		const attempt = (): ReturnType<typeof ensureOrganizationProvisioned> =>
			ensureOrganizationProvisioned({
				organizationId,
				store,
				centralClient: central.client,
				signStatement: recordingSigner().sign,
			});
		// Act / Assert
		await expect(attempt()).resolves.toEqual({
			kind: 'store-unavailable',
			reason: 'database-error',
		});
		expect(state.readCurrent()).toBe('settingUp');
		writesAvailable = true;
		await expect(attempt()).resolves.toEqual({ kind: 'ready' });
		expect(central.calls).toHaveLength(2);
	});

	it.each([
		['the bytes it sent', 'initialize'],
		['a stamp it already held, after a lost setup reply', 'already-provisioned'],
	] as const)(
		"records central's own facts after Provisioned when central stored %s, never the sent bytes (D5)",
		async (_label, held) => {
			// Arrange: central answers `provisioned` either way; only its digest read tells them apart.
			const state = controlledStore('settingUp');
			const signer = recordingSigner();
			const centralFacts: OrganizationStampFacts = {
				digest: held === 'initialize' ? 'a'.repeat(64) : 'b'.repeat(64),
				expiresAt: 2_219_356_800,
				signingKeyId: 'central-held-key',
			};
			const seeded: OrganizationStampFacts[] = [];
			// Act
			const result = await ensureOrganizationProvisioned({
				organizationId,
				store: state.store,
				stamps: {
					seedConfirmedStamp: async ({ stamp }) => {
						seeded.push(stamp);
						return { kind: 'available', value: true };
					},
				},
				signStatement: signer.sign,
				centralClient: {
					provisionOrganization: async () => ({ kind: 'provisioned' }),
					readStatementDigest: async () => ({ kind: 'current', ...centralFacts }),
				},
			});
			// Assert
			expect(result).toEqual({ kind: 'ready' });
			expect(seeded).toEqual([centralFacts]);
		},
	);
	it("leaves the record for first use when central's digest read after Provisioned fails", async () => {
		const state = controlledStore('settingUp');
		const seeded: unknown[] = [];
		const result = await ensureOrganizationProvisioned({
			organizationId,
			store: state.store,
			stamps: {
				seedConfirmedStamp: async (request) => {
					seeded.push(request);
					return { kind: 'available', value: true };
				},
			},
			signStatement: recordingSigner().sign,
			centralClient: {
				provisionOrganization: async () => ({ kind: 'provisioned' }),
				readStatementDigest: async () => {
					throw new Error('Link lost');
				},
			},
		});
		expect(result).toEqual({ kind: 'ready' });
		expect(seeded).toEqual([]);
	});
});
