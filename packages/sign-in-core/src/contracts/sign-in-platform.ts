import type { BatchItem } from 'drizzle-orm/batch';
import { z } from 'zod';

import type { CentralLinkClient } from '#sign-in-core/central-link/central-link-client';
import type { SignInObservation } from '#sign-in-core/contracts/sign-in-observation';
import type { SignInRequestLimiter } from '#sign-in-core/request-limits/request-limit-policy';

export const uuid7Schema = z.uuidv7().brand<'Uuid7'>();
export type Uuid7 = z.infer<typeof uuid7Schema>;
export const epochMillisecondsSchema = z.number().int().nonnegative().brand<'EpochMilliseconds'>();
export type EpochMilliseconds = z.infer<typeof epochMillisecondsSchema>;

export interface SignInClock {
	readonly now: () => EpochMilliseconds;
}

export interface SignInIdSource {
	readonly nextId: () => Uuid7;
}

export type AtomicStatement = BatchItem<'sqlite'> & { readonly all: () => unknown };
export type AtomicStatementGroup = readonly [AtomicStatement, ...AtomicStatement[]];
export type AtomicRunOutcome =
	| { readonly kind: 'committed'; readonly rows: readonly (readonly unknown[])[] }
	| { readonly kind: 'failed'; readonly reason: 'database-error' };
export type AtomicRunner = (group: AtomicStatementGroup) => Promise<AtomicRunOutcome>;

/** A deadline on the platform's own timer; its signal aborts with a `TimeoutError` reason. */
export interface SignInDeadline {
	readonly signal: AbortSignal;
	readonly cancel: () => void;
}
/** Injected like the clock, so tests fire deadlines themselves instead of waiting on time. */
export interface SignInDeadlines {
	readonly start: (milliseconds: number) => SignInDeadline;
}

/** The one key algorithm the core uses: ES256's ECDSA on P-256. */
export interface SignInEcdsaKeyAlgorithm {
	readonly name: 'ECDSA';
	readonly namedCurve: 'P-256';
}
/** ES256 signing: ECDSA with SHA-256. */
export interface SignInEcdsaSignatureAlgorithm {
	readonly name: 'ECDSA';
	readonly hash: 'SHA-256';
}
export type SignInKeyUsage = 'sign' | 'verify';
/** A JWK as a runtime exports it; the core checks each member before use. */
export interface SignInExportedJwk {
	readonly kty?: string | undefined;
	readonly crv?: string | undefined;
	readonly x?: string | undefined;
	readonly y?: string | undefined;
	readonly d?: string | undefined;
}
/** An ES256 private key as JWK, the only shape the core imports. */
export interface SignInEcPrivateJwk {
	readonly kty: 'EC';
	readonly crv: 'P-256';
	readonly x: string;
	readonly y: string;
	readonly d: string;
}

/**
 * The subset of standard Web Crypto the core uses: SHA-256, and ES256 key creation, export,
 * import and signing. One signature per operation, written without DOM-only names, so both
 * runtimes' own `crypto.subtle` satisfy it and a test can wrap it to record calls. Key usages
 * are a mutable array because Node's `subtle` declares them so.
 */
export interface SignInSubtleCrypto {
	readonly digest: (algorithm: 'SHA-256', data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
	readonly generateKey: (
		algorithm: SignInEcdsaKeyAlgorithm,
		extractable: boolean,
		keyUsages: SignInKeyUsage[],
	) => Promise<{ readonly privateKey: CryptoKey; readonly publicKey: CryptoKey }>;
	readonly exportKey: (format: 'jwk', key: CryptoKey) => Promise<SignInExportedJwk>;
	readonly importKey: (
		format: 'jwk',
		keyData: SignInEcPrivateJwk,
		algorithm: SignInEcdsaKeyAlgorithm,
		extractable: boolean,
		keyUsages: SignInKeyUsage[],
	) => Promise<CryptoKey>;
	readonly sign: (
		algorithm: SignInEcdsaSignatureAlgorithm,
		key: CryptoKey,
		data: Uint8Array<ArrayBuffer>,
	) => Promise<ArrayBuffer>;
}

/** The host's randomness and crypto (R30): the core never reads the runtime's `crypto`. */
export interface SignInCrypto {
	readonly getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
	readonly subtle: SignInSubtleCrypto;
}

export interface SignInPlatform {
	readonly requestLimiter: SignInRequestLimiter;
	readonly centralClient: CentralLinkClient;
	readonly clock: SignInClock;
	readonly crypto: SignInCrypto;
	readonly deadlines: SignInDeadlines;
	readonly ids: SignInIdSource;
	readonly runAtomically: AtomicRunner;
	readonly log: (observation: SignInObservation) => void;
}
