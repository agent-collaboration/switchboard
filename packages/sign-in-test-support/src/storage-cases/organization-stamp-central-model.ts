import {
	readOrganizationStatementFacts,
	type OrganizationProvisioningClient,
	type OrganizationStampFacts,
	type ProvisionOrganizationAnswer,
	type SignOrganizationStatement,
} from '@agent-collaboration/sign-in-core';
import { decodeJwt } from 'jose';

import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

/** What the next provisioning send meets. `lose-after-apply` is a reply lost after the swap. */
export type CentralStampBehaviour =
	| 'answer'
	| 'lose-before-apply'
	| 'lose-after-apply'
	| 'refuse-invalid-statement';

export interface CentralStampSend {
	readonly organizationId: string;
	readonly statement: string;
}
export interface CentralStampModel {
	readonly client: Pick<
		OrganizationProvisioningClient,
		'provisionOrganization' | 'readStatementDigest'
	>;
	/** Every statement central received, byte for byte, in arrival order. */
	readonly sends: readonly CentralStampSend[];
	readonly digestReads: () => number;
	readonly appliedSwaps: () => number;
	readonly stored: (organizationId: string) => OrganizationStampFacts | null;
	readonly hold: (organizationId: string, statement: string) => Promise<void>;
	readonly nextBehaviours: (...behaviours: readonly CentralStampBehaviour[]) => void;
	/** WS7: `unavailable` makes the digest read fail as a broken link would, never as `none`. */
	readonly answerDigestReads: (mode: 'answer' | 'unavailable') => void;
	/** A send a peer received and held without deciding; it counts as received, not applied. */
	readonly recordHeldSend: (organizationId: string, statement: string) => void;
	/** WS7: central restarts empty (owner, 12 Nov) and holds no stamp for anyone. */
	readonly restartEmpty: () => void;
}

/**
 * A stand-in that applies central's replacement decision at the B2e pin e847a888
 * (`statement_replacement.rs`): a byte-identical stored statement is "already done", a
 * statement naming the stored digest replaces it, anything else is stale. It proves sign-in's
 * side of the exchange only, never central's verification, expiry checks or storage.
 */
export function createCentralStampModel(): CentralStampModel {
	const sends: CentralStampSend[] = [];
	const behaviours: CentralStampBehaviour[] = [];
	const stored = new Map<
		string,
		{ readonly statement: string; readonly facts: OrganizationStampFacts }
	>();
	let digestReads = 0;
	let appliedSwaps = 0;
	let digestMode: 'answer' | 'unavailable' = 'answer';
	async function decide(
		organizationId: string,
		statement: string,
	): Promise<ProvisionOrganizationAnswer> {
		const facts = await readOrganizationStatementFacts(webSignInCrypto, statement);
		const replaces = decodeJwt(statement)['replaces'];
		const current = stored.get(organizationId);
		if (current === undefined) {
			if (typeof replaces === 'string') return { kind: 'refused', reason: 'stale' };
			stored.set(organizationId, { statement, facts });
			return { kind: 'provisioned' };
		}
		if (current.facts.digest === facts.digest || typeof replaces !== 'string')
			return { kind: 'provisioned' };
		if (replaces !== current.facts.digest) return { kind: 'refused', reason: 'stale' };
		stored.set(organizationId, { statement, facts });
		appliedSwaps += 1;
		return { kind: 'provisioned' };
	}
	return {
		sends,
		digestReads: () => digestReads,
		appliedSwaps: () => appliedSwaps,
		stored: (organizationId) => stored.get(organizationId)?.facts ?? null,
		async hold(organizationId, statement): Promise<void> {
			stored.set(organizationId, {
				statement,
				facts: await readOrganizationStatementFacts(webSignInCrypto, statement),
			});
		},
		nextBehaviours(...next): void {
			behaviours.push(...next);
		},
		answerDigestReads(mode): void {
			digestMode = mode;
		},
		recordHeldSend(organizationId, statement): void {
			sends.push({ organizationId, statement });
		},
		restartEmpty(): void {
			stored.clear();
		},
		client: {
			async provisionOrganization({
				organizationId,
				organizationStatement,
			}): Promise<ProvisionOrganizationAnswer> {
				sends.push({ organizationId, statement: organizationStatement });
				const behaviour = behaviours.shift() ?? 'answer';
				if (behaviour === 'lose-before-apply') return { kind: 'unknown', reason: 'timeout' };
				if (behaviour === 'refuse-invalid-statement')
					return { kind: 'refused', reason: 'invalid-statement' };
				const answer = await decide(organizationId, organizationStatement);
				return behaviour === 'lose-after-apply' ? { kind: 'unknown', reason: 'timeout' } : answer;
			},
			async readStatementDigest(organizationId) {
				digestReads += 1;
				if (digestMode === 'unavailable') return { kind: 'unavailable', reason: 'unavailable' };
				const current = stored.get(organizationId);
				return current === undefined
					? { kind: 'none' }
					: {
							kind: 'current',
							digest: current.facts.digest,
							expiresAt: current.facts.expiresAt,
							signingKeyId: current.facts.signingKeyId,
						};
			},
		},
	};
}

const encoder = new TextEncoder();
function base64Url(value: unknown): string {
	return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value))))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '');
}

/**
 * Compact statements in the sign-in profile, under a chosen `kid`. The signature segment is a
 * counter, so two signings at one instant still differ in bytes: the guard, not determinism,
 * must keep a second statement from being sent. Nothing here verifies signatures.
 */
export function createStatementSigner(props: {
	readonly now: () => number;
	readonly signingKeyId: () => string;
}): SignOrganizationStatement & { readonly signatures: () => number } {
	let signatures = 0;
	const sign: SignOrganizationStatement = async (request) => {
		signatures += 1;
		const issuedAt = Math.floor(props.now() / 1000);
		return [
			base64Url({ alg: 'EdDSA', typ: 'fleet-organization-stamp+jwt', kid: props.signingKeyId() }),
			base64Url({
				purpose: 'fleet-organization-stamp',
				version: 1,
				iss: 'https://sign-in.example.invalid',
				aud: 'https://central.example.invalid/identity',
				sub: request.organizationId,
				organization_id: request.organizationId,
				iat: issuedAt,
				exp: issuedAt + 10_368_000,
				...(request.replaces === undefined ? {} : { replaces: request.replaces }),
			}),
			base64Url(`signature-${signatures}`),
		].join('.');
	};
	return Object.assign(sign, { signatures: (): number => signatures });
}
