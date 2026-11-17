import type { BetterAuthPlugin } from '@better-auth/core';
import {
	generateAuthenticationOptions,
	type AuthenticationResponseJSON,
	verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { z } from 'zod';

import { requireFactorActor } from '#sign-in-core/better-auth/second-factor-authorization';
import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import { uuid7Schema, type SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import { personIdSchema } from '#sign-in-core/storage/models/sign-in-store';
import type { SignInStore } from '#sign-in-core/storage/models/sign-in-store';

const assertionSchema = z.object({
	id: z.string().min(1),
	rawId: z.string().min(1),
	type: z.literal('public-key'),
	response: z.object({
		clientDataJSON: z.string().min(1),
		authenticatorData: z.string().min(1),
		signature: z.string().min(1),
		userHandle: z.string().optional(),
	}),
	clientExtensionResults: z.looseObject({
		appid: z.boolean().optional(),
		credProps: z.object({ rk: z.boolean().optional() }).optional(),
	}),
	authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
function authenticationResponse(
	input: z.infer<typeof assertionSchema>,
): AuthenticationResponseJSON {
	const { userHandle, ...response } = input.response;
	const { authenticatorAttachment, ...credential } = input;
	const { appid, credProps, ...extensions } = credential.clientExtensionResults;
	return {
		...credential,
		response: { ...response, ...(userHandle === undefined ? {} : { userHandle }) },
		clientExtensionResults: {
			...extensions,
			...(appid === undefined ? {} : { appid }),
			...(credProps?.rk === undefined ? {} : { credProps: { rk: credProps.rk } }),
		},
		...(authenticatorAttachment === undefined ? {} : { authenticatorAttachment }),
	};
}

const challengeSchema = z.strictObject({
	personId: personIdSchema,
	sessionId: uuid7Schema,
	challenge: z.string().min(1),
});

/** Confirmation reuses the authenticated social session; it cannot create a
 * session, trust a device, or turn a backup flag into a key-protection claim. */
export function createPasskeyConfirmationPlugin(props: {
	readonly issuer: string;
	readonly store: Pick<SignInStore, 'factors' | 'passkeys' | 'factorChanges'>;
	readonly platform: Pick<SignInPlatform, 'clock' | 'ids'>;
}): BetterAuthPlugin {
	return {
		id: 'sign-in-passkey-confirmation',
		endpoints: {
			generatePasskeyConfirmationOptions: createAuthEndpoint(
				'/passkey/confirm-options',
				{ method: 'POST', body: z.strictObject({}) },
				async (context) => {
					const actor = await requireFactorActor({ context, store: props.store.factors });
					if (actor.factors.enrollment.kind === 'never-enrolled')
						throw new APIError('FORBIDDEN', { code: 'APP_REQUIRED', message: 'appRequired' });
					const credentials = requireStoredValue(
						await props.store.passkeys.listForPerson(actor.personId),
					);
					if (credentials.length === 0)
						throw new APIError('NOT_FOUND', { message: 'passkey-not-found' });
					const options = await generateAuthenticationOptions({
						rpID: new URL(props.issuer).hostname,
						userVerification: 'required',
						allowCredentials: credentials.map((credential) => ({ id: credential.credentialId })),
					});
					const challengeId = props.platform.ids.nextId();
					const now = props.platform.clock.now();
					await context.context.internalAdapter.createVerificationValue({
						id: props.platform.ids.nextId(),
						identifier: `passkey-confirm:${actor.sessionId}:${challengeId}`,
						value: JSON.stringify({
							personId: actor.personId,
							sessionId: actor.sessionId,
							challenge: options.challenge,
						}),
						expiresAt: new Date(now + 5 * 60 * 1000),
						createdAt: new Date(now),
						updatedAt: new Date(now),
					});
					return context.json({ challengeId, options });
				},
			),
			confirmPasskey: createAuthEndpoint(
				'/passkey/confirm',
				{
					method: 'POST',
					body: z.strictObject({ challengeId: uuid7Schema, response: assertionSchema }),
				},
				async (context) => {
					const actor = await requireFactorActor({ context, store: props.store.factors });
					if (actor.factors.enrollment.kind === 'never-enrolled')
						throw new APIError('FORBIDDEN', { code: 'APP_REQUIRED', message: 'appRequired' });
					const consumed = await context.context.internalAdapter.consumeVerificationValue(
						`passkey-confirm:${actor.sessionId}:${context.body.challengeId}`,
					);
					if (consumed === null || consumed.expiresAt.getTime() <= props.platform.clock.now())
						throw new APIError('UNAUTHORIZED', { message: 'passkey-challenge-invalid' });
					let payload: unknown;
					try {
						payload = JSON.parse(consumed.value);
					} catch {
						throw new APIError('UNAUTHORIZED', { message: 'passkey-challenge-invalid' });
					}
					const challenge = challengeSchema.safeParse(payload);
					if (
						!challenge.success ||
						challenge.data.personId !== actor.personId ||
						challenge.data.sessionId !== actor.sessionId
					)
						throw new APIError('UNAUTHORIZED', { message: 'passkey-challenge-invalid' });
					const credential = requireStoredValue(
						await props.store.passkeys.readForPerson(actor.personId, context.body.response.id),
					);
					if (credential === null)
						throw new APIError('UNAUTHORIZED', { message: 'passkey-not-found' });
					const change = {
						requestId: props.platform.ids.nextId(),
						actorPersonId: actor.personId,
						action: 'passkey-confirmed',
						targetId: credential.id,
					} as const;
					requireStoredValue(await props.store.factorChanges.record(change, 'intent'));
					let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
					try {
						verification = await verifyAuthenticationResponse({
							response: authenticationResponse(context.body.response),
							expectedChallenge: challenge.data.challenge,
							expectedOrigin: props.issuer,
							expectedRPID: new URL(props.issuer).hostname,
							credential: {
								id: credential.credentialId,
								publicKey: Uint8Array.from(atob(credential.publicKey), (character) =>
									character.charCodeAt(0),
								),
								counter: credential.counter,
							},
							requireUserVerification: true,
						});
					} catch {
						throw new APIError('UNAUTHORIZED', {
							code: 'PASSKEY_INVALID',
							message: 'passkey-invalid',
						});
					}
					if (!verification.verified || !verification.authenticationInfo.userVerified)
						throw new APIError('UNAUTHORIZED', {
							code: 'USER_VERIFICATION_REQUIRED',
							message: 'user-verification-required',
						});
					const confirmed = requireStoredValue(
						await props.store.passkeys.confirmSession({
							personId: actor.personId,
							sessionId: actor.sessionId,
							passkeyId: credential.id,
							verifiedCounter: verification.authenticationInfo.newCounter,
						}),
					);
					if (confirmed.kind !== 'confirmed')
						throw new APIError('UNAUTHORIZED', { message: 'credential-or-session-not-live' });
					requireStoredValue(await props.store.factorChanges.record(change, 'outcome'));
					return context.json({ status: true });
				},
			),
		},
	};
}
