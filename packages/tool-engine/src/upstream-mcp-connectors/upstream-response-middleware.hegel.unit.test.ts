import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	redactCredentialText,
	redactExactCredentialText,
	redactUpstreamCatalogValue,
	redactUpstreamResponse,
	toRedactedJsonValue,
} from '#upstream-mcp-connectors/upstream-response-middleware';

const settings = { testCases: 500, derandomize: true, database: hegel.Database.disabled };

it('replaces exact configured values while preserving ordinary text', () => {
	hegel.test((tc) => {
		const value = tc.draw(generators.integers({ minValue: 1, maxValue: 1000000 }));
		const secret = `credential-${value}`;
		tc.note(`secret=${secret}`);
		expect(
			redactExactCredentialText(`before ${secret} after ${secret}`, { exactValues: [secret, ''] }),
		).toBe('before [REDACTED] after [REDACTED]');
		expect(redactExactCredentialText('ordinary text', { exactValues: [secret] })).toBe(
			'ordinary text',
		);
	}, settings);
});

it('redacts recognized credential patterns and preserves surrounding ordinary text', () => {
	hegel.test((tc) => {
		const value = tc.draw(generators.integers({ minValue: 1, maxValue: 1000000 }));
		tc.note(`credential suffix=${value}`);
		for (const pattern of [
			`Bearer abc${value}`,
			`Basic abc${value}`,
			`api_key=abc${value}`,
			`token=abc${value}`,
			`password=abc${value}`,
			`secret=abc${value}`,
		]) {
			expect(redactCredentialText(`before ${pattern} after`)).toBe('before [REDACTED] after');
		}
		expect(redactCredentialText(`ordinary ${value}`)).toBe(`ordinary ${value}`);
	}, settings);
});

it('redacts nested credential keys while retaining ordinary fields', () => {
	hegel.test((tc) => {
		const value = tc.draw(generators.integers({ minValue: 1, maxValue: 1000000 }));
		const secret = `opaque-${value}`;
		tc.note(`credential suffix=${value}`);
		expect(
			redactUpstreamResponse({
				rows: [
					{
						nested: {
							'x-api-key': secret,
							refresh_token: secret,
							clientSecret: secret,
							password: secret,
							authorization: secret,
							author: `ordinary-${value}`,
						},
					},
				],
			}),
		).toEqual({
			rows: [
				{
					nested: {
						'x-api-key': '[REDACTED]',
						refresh_token: '[REDACTED]',
						clientSecret: '[REDACTED]',
						password: '[REDACTED]',
						authorization: '[REDACTED]',
						author: `ordinary-${value}`,
					},
				},
			],
		});
	}, settings);
});

it('redacts parsed values recursively and catalog values only by exact match', () => {
	hegel.test((tc) => {
		const value = tc.draw(generators.integers({ minValue: 1, maxValue: 1000000 }));
		const secret = `opaque-"\\-${value}`;
		tc.note(`credential suffix=${value}`);
		const parsed: unknown = JSON.parse(
			JSON.stringify({
				nested: [{ value: `before ${secret} after`, example: 'Bearer example' }],
				ordinary: value,
			}),
		);
		const options = { exactValues: [secret] };
		expect(toRedactedJsonValue(parsed, options)).toEqual({
			nested: [{ value: 'before [REDACTED] after', example: '[REDACTED]' }],
			ordinary: value,
		});
		expect(redactUpstreamCatalogValue(parsed, options)).toEqual({
			nested: [{ value: 'before [REDACTED] after', example: 'Bearer example' }],
			ordinary: value,
		});
	}, settings);
});
