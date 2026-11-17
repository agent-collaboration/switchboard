import type { SignInClock } from '@agent-collaboration/sign-in-core';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { z } from 'zod';

export type PersonAuthRequest = (pathname: string, init?: RequestInit) => Promise<Response>;
const setupSchema = z.object({
	method: z.literal('totp'),
	totpURI: z.string().startsWith('otpauth://'),
	backupCodes: z.array(z.string().min(1)).min(1),
});
interface AppEntry {
	readonly secret: string;
	readonly digits: number;
	readonly periodSeconds: number;
	readonly recoveryCodes: readonly string[];
}
export interface SoftwareTotpAuthenticator {
	readonly observeEnrollment: (email: string, value: unknown) => void;
	readonly enrollApp: (email: string, auth: PersonAuthRequest) => Promise<Response>;
	readonly confirmApp: (email: string, auth: PersonAuthRequest) => Promise<Response>;
	readonly ensureConfirmed: (email: string, auth: PersonAuthRequest) => Promise<void>;
	readonly currentCode: (email: string) => Promise<string>;
	readonly recoveryCode: (email: string, index?: number) => string;
	readonly recoveryCodeCount: (email: string) => number;
}

/** A controlled external authenticator, owned by one harness. It learns the
 * secret only from the native one-time setup response and retains it in memory.
 * It never reads the sign-in DB, decrypts a server row, or prints credential data. */
export function createSoftwareTotpAuthenticator(clock: SignInClock): SoftwareTotpAuthenticator {
	const appsByEmail = new Map<string, AppEntry>();
	function requireApp(email: string): AppEntry {
		const app = appsByEmail.get(email.toLowerCase());
		if (app === undefined) throw new Error('Software authenticator has no enrolled app');
		return app;
	}
	async function currentCode(email: string): Promise<string> {
		const app = requireApp(email);
		return createOTP(app.secret, { digits: app.digits, period: app.periodSeconds }).hotp(
			Math.floor(clock.now() / (app.periodSeconds * 1000)),
		);
	}
	function observeEnrollment(email: string, value: unknown): void {
		const setup = setupSchema.parse(value);
		const uri = new URL(setup.totpURI);
		const secret = z.string().min(1).parse(uri.searchParams.get('secret'));
		appsByEmail.set(email.toLowerCase(), {
			secret: new TextDecoder('utf-8', { fatal: true }).decode(base32.decode(secret)),
			digits: z.coerce
				.number()
				.int()
				.min(1)
				.max(8)
				.parse(uri.searchParams.get('digits') ?? 6),
			periodSeconds: z.coerce
				.number()
				.int()
				.positive()
				.parse(uri.searchParams.get('period') ?? 30),
			recoveryCodes: setup.backupCodes,
		});
	}
	async function enrollApp(email: string, auth: PersonAuthRequest): Promise<Response> {
		const response = await auth('/api/auth/two-factor/enable', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ method: 'totp' }),
		});
		if (!response.ok) return response;
		observeEnrollment(email, await response.clone().json());
		return response;
	}
	async function confirmApp(email: string, auth: PersonAuthRequest): Promise<Response> {
		return auth('/api/auth/two-factor/verify-totp', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code: await currentCode(email) }),
		});
	}
	return {
		observeEnrollment,
		enrollApp,
		confirmApp,
		currentCode,
		async ensureConfirmed(email, auth): Promise<void> {
			if (!appsByEmail.has(email.toLowerCase()) && !(await enrollApp(email, auth)).ok)
				throw new Error('Native app enrollment refused');
			if (!(await confirmApp(email, auth)).ok) throw new Error('Native app confirmation refused');
		},
		recoveryCode(email, index = 0): string {
			const recovery = requireApp(email).recoveryCodes[index];
			if (recovery === undefined)
				throw new Error('Software authenticator has no such recovery code');
			return recovery;
		},
		recoveryCodeCount: (email) => requireApp(email).recoveryCodes.length,
	};
}
