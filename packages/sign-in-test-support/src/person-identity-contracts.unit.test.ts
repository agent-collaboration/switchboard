import { readFile } from 'node:fs/promises';

import {
	organizationPersonTokenClaimsSchema,
	personSessionConfirmationSchema,
} from '@agent-collaboration/sign-in-core/person-identity';
import { personTokenClaimsSchema } from '@agent-collaboration/tool-access/contracts';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import addFormats from 'ajv-formats';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { personIdentityFixtureArtifacts } from '#sign-in-test-support/test-fixtures/person-identity-fixtures';

useControlledSignInClock();

const fixtureDirectory = new URL(
	'../../sign-in-core/contract-fixtures/person-identity/',
	import.meta.url,
);
const containerSchema = z.object({
	contract: z.string(),
	examples: z.record(z.string(), z.unknown()),
});
let generatedValidator: Promise<ValidateFunction> | undefined;
function generatedK6Validator(): Promise<ValidateFunction> {
	generatedValidator ??= (async (): Promise<ValidateFunction> => {
		const schema = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(await readFile(new URL('K6.schema.json', fixtureDirectory), 'utf8')));
		const validator = new Ajv2020();
		addFormats(validator);
		return validator.compile(schema);
	})();
	return generatedValidator;
}

it.each(['method without time', 'time without method'] as const)(
	'K6 rejects %s through both the producer parser and generated JSON Schema',
	async (variant) => {
		const container = containerSchema.parse(personIdentityFixtureArtifacts()['K6.fixtures.json']);
		const claims = organizationPersonTokenClaimsSchema.parse(container.examples.providerSession);
		const partial =
			variant === 'method without time'
				? { ...claims, second_factor_method: 'app' }
				: { ...claims, second_factor_at: 2_208_988_790 };
		const validate = await generatedK6Validator();
		expect({
			zod: organizationPersonTokenClaimsSchema.safeParse(partial).success,
			jsonSchema: validate(partial),
		}).toEqual({ zod: false, jsonSchema: false });
	},
);

it('K6 accepts neither and all paired methods through both validation paths', async () => {
	const container = containerSchema.parse(personIdentityFixtureArtifacts()['K6.fixtures.json']);
	const validate = await generatedK6Validator();
	for (const claims of Object.values(container.examples))
		expect({
			zod: organizationPersonTokenClaimsSchema.safeParse(claims).success,
			jsonSchema: validate(claims),
		}).toEqual({ zod: true, jsonSchema: true });
});

it('keeps producer-owned schemas and named structural examples current', async () => {
	await Promise.all(
		Object.entries(personIdentityFixtureArtifacts()).map(
			async ([name, artifact]): Promise<void> => {
				expect(JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'))).toEqual(
					artifact,
				);
			},
		),
	);
	const confirmation = containerSchema.parse(
		JSON.parse(await readFile(new URL('K5.fixtures.json', fixtureDirectory), 'utf8')),
	);
	const claims = containerSchema.parse(
		JSON.parse(await readFile(new URL('K6.fixtures.json', fixtureDirectory), 'utf8')),
	);
	expect(confirmation.contract).toBe('K5SessionConfirmation');
	expect(claims.contract).toBe('K6OrganizationPersonTokenClaims');
	for (const example of Object.values(confirmation.examples))
		expect(personSessionConfirmationSchema.safeParse(example).success).toBe(true);
	for (const example of Object.values(claims.examples))
		expect(organizationPersonTokenClaimsSchema.safeParse(example).success).toBe(true);
});

it('refuses missing organization/session fields and audience arrays without changing the live token schema', () => {
	const container = containerSchema.parse(personIdentityFixtureArtifacts()['K6.fixtures.json']);
	const claims = organizationPersonTokenClaimsSchema.parse(container.examples.providerSession);
	const { organization_id: _organization, ...withoutOrganization } = claims;
	const { sid: _session, ...withoutSession } = claims;
	for (const input of [
		withoutOrganization,
		withoutSession,
		{ ...claims, aud: [claims.aud] },
		{ ...claims, second_factor_at: -1 },
		{ ...claims, second_factor_at: null },
		{ ...claims, second_factor_method: 'unrecognized' },
		{ ...claims, second_factor_method: null },
		{ ...claims, amr: ['otp', 'mfa'] },
		{ ...withoutOrganization, organizationId: claims.organization_id },
	])
		expect(organizationPersonTokenClaimsSchema.safeParse(input).success).toBe(false);
	expect(
		personSessionConfirmationSchema.safeParse({ active: false, sub: claims.sub }).success,
	).toBe(false);
	expect(personTokenClaimsSchema.safeParse(withoutOrganization).success).toBe(true);
	expect(
		organizationPersonTokenClaimsSchema.safeParse({ ...claims, registered_extra: 'kept' }).success,
	).toBe(true);
});

it('preserves valid claims through JSON across controlled timestamps and every C13 method family', () => {
	const container = containerSchema.parse(personIdentityFixtureArtifacts()['K6.fixtures.json']);
	const claims = organizationPersonTokenClaimsSchema.parse(container.examples.providerSession);
	hegel.test(
		(testCase) => {
			const issued = testCase.draw(
				generators.integers({ minValue: 1_800_000_000, maxValue: 2_208_988_800 }),
			);
			const lifetime = testCase.draw(generators.integers({ minValue: 1, maxValue: 600 }));
			const methods = ['app', 'recoveryCode', 'passkey'] as const;
			const method = testCase.draw(generators.integers({ minValue: 0, maxValue: 3 }));
			const confirmedMethod = methods[method - 1];
			if (method !== 0 && confirmedMethod === undefined)
				throw new Error('Generated factor method is outside the declared domain');
			const secondFactor =
				method === 0
					? {}
					: {
							second_factor_at: issued - 1,
							second_factor_method: confirmedMethod,
						};
			const wireClaims = { ...claims, iat: issued, exp: issued + lifetime, ...secondFactor };
			expect(
				organizationPersonTokenClaimsSchema.parse(JSON.parse(JSON.stringify(wireClaims))),
			).toEqual(wireClaims);
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
