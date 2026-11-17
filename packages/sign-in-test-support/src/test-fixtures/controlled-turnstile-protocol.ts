import { Response as WorkerResponse, type V4FetchHandler } from 'miniflare';
import { z } from 'zod';

import { turnstileTestSecret } from '#sign-in-test-support/test-fixtures/turnstile-test-keys';

const verificationRequestSchema = z.strictObject({
	secret: z.literal(turnstileTestSecret),
	response: z.string().min(1),
	remoteip: z.string().optional(),
});
export type TurnstileVerificationRequest = z.infer<typeof verificationRequestSchema>;

interface IssuedTurnstileToken {
	readonly action: string;
	readonly hostname: string;
	readonly verdict: 'accepted' | 'rejected';
}

interface VerificationHold {
	readonly entered: PromiseWithResolvers<void>;
	readonly released: PromiseWithResolvers<void>;
}

interface TurnstileVerificationControl {
	readonly entered: Promise<void>;
	readonly release: () => void;
}

export interface ControlledTurnstileProtocol {
	readonly issueToken: (props: IssuedTurnstileToken) => string;
	readonly holdToken: (token: string) => TurnstileVerificationControl;
	readonly failResponses: () => void;
	readonly requests: () => readonly TurnstileVerificationRequest[];
	readonly fetch: V4FetchHandler;
}

/** Models only the external verifier. The real captcha plugin sends and checks
 * every request. Published test keys are accepted; other secrets are not retained. */
export function createControlledTurnstileProtocol(): ControlledTurnstileProtocol {
	const issuedTokens = new Map<string, IssuedTurnstileToken>();
	const spentTokens = new Set<string>();
	const verificationHolds = new Map<string, VerificationHold>();
	const observedRequests: TurnstileVerificationRequest[] = [];
	let issuedCount = 0;
	let responseMode: 'normal' | 'error' = 'normal';
	return {
		issueToken(props: IssuedTurnstileToken): string {
			issuedCount += 1;
			const token = `controlled-turnstile-token-${issuedCount}`;
			issuedTokens.set(token, props);
			return token;
		},
		holdToken(token: string): TurnstileVerificationControl {
			const hold = {
				entered: Promise.withResolvers<void>(),
				released: Promise.withResolvers<void>(),
			};
			verificationHolds.set(token, hold);
			return { entered: hold.entered.promise, release: (): void => hold.released.resolve() };
		},
		failResponses(): void {
			responseMode = 'error';
		},
		requests(): readonly TurnstileVerificationRequest[] {
			return observedRequests.map(
				(request: TurnstileVerificationRequest): TurnstileVerificationRequest => ({ ...request }),
			);
		},
		async fetch(request: Parameters<V4FetchHandler>[0]): Promise<WorkerResponse> {
			if (request.method !== 'POST')
				return WorkerResponse.json({ error: 'unexpected-siteverify-method' }, { status: 405 });
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return WorkerResponse.json({ error: 'invalid-siteverify-json' }, { status: 400 });
			}
			const parsed = verificationRequestSchema.safeParse(body);
			if (!parsed.success)
				return WorkerResponse.json({ error: 'invalid-siteverify-request' }, { status: 400 });
			const verification = parsed.data;
			observedRequests.push(verification);
			const hold = verificationHolds.get(verification.response);
			if (hold !== undefined) {
				hold.entered.resolve();
				await hold.released.promise;
				verificationHolds.delete(verification.response);
			}
			if (responseMode === 'error')
				return WorkerResponse.json({ error: 'controlled-siteverify-error' }, { status: 503 });
			if (spentTokens.has(verification.response))
				return WorkerResponse.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
			const issued = issuedTokens.get(verification.response);
			if (issued === undefined)
				return WorkerResponse.json({ success: false, 'error-codes': ['invalid-input-response'] });
			spentTokens.add(verification.response);
			if (issued.verdict === 'rejected')
				return WorkerResponse.json({ success: false, 'error-codes': ['invalid-input-response'] });
			return WorkerResponse.json({
				success: true,
				'error-codes': [],
				action: issued.action,
				hostname: issued.hostname,
			});
		},
	};
}
