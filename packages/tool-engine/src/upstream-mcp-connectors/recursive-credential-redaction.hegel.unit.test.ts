import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	redactUpstreamResponse,
	redactUpstreamCatalogValue,
	redactThrownError,
} from '#upstream-mcp-connectors/upstream-response-middleware';

const settings = {
	testCases: 500,
	seed: 20261117,
	derandomize: true,
	database: hegel.Database.disabled,
};

it('redacts nested response keys by exact and pattern policy while using original key hints', () => {
	hegel.test((tc) => {
		const secret = tc.draw(generators.text({ alphabet: 'QWXYZé雪', minSize: 1, maxSize: 30 }));
		tc.note(`secret=${JSON.stringify(secret)}`);
		const options = { exactValues: [secret] };
		expect(
			redactUpstreamResponse(
				{
					nested: [
						{
							[`prefix ${secret}`]: 'ordinary',
							'Bearer abc123': 'kept',
							[`${secret}token`]: 'private',
						},
					],
				},
				options,
			),
		).toEqual({
			nested: [
				{ 'prefix [REDACTED]': 'ordinary', '[REDACTED]': 'kept', '[REDACTED]token': '[REDACTED]' },
			],
		});
	}, settings);
});

it('redacts nested catalog keys exactly while preserving recognized patterns', () => {
	hegel.test((tc) => {
		const secret = tc.draw(generators.text({ alphabet: 'QWXYZé雪', minSize: 1, maxSize: 30 }));
		tc.note(`secret=${JSON.stringify(secret)}`);
		expect(
			redactUpstreamCatalogValue(
				{ nested: [{ [`prefix ${secret}`]: secret, 'Bearer 777': 'Bearer 777' }] },
				{ exactValues: [secret] },
			),
		).toEqual({ nested: [{ 'prefix [REDACTED]': '[REDACTED]', 'Bearer 777': 'Bearer 777' }] });
	}, settings);
});

it('keeps original credential-key classification after the key itself is redacted', () => {
	const options = { exactValues: ['authorization'] };
	expect(redactUpstreamResponse({ authorization: 'ordinary' }, options)).toEqual({
		'[REDACTED]': '[REDACTED]',
	});
	expect(redactUpstreamCatalogValue({ authorization: 'ordinary' }, options)).toEqual({
		'[REDACTED]': 'ordinary',
	});
});

it('redacts whole matching numbers and retains numbers with only a partial match', () => {
	hegel.test((tc) => {
		const number = tc.draw(generators.integers({ minValue: 10, maxValue: 999999 }));
		const partial = Number(`1${number}`);
		tc.note(`number=${number} partial=${partial}`);
		const input = { nested: [number, partial] };
		const expected = { nested: ['[REDACTED]', partial] };
		expect(redactUpstreamResponse(input, { exactValues: [String(number)] })).toEqual(expected);
		expect(redactUpstreamCatalogValue(input, { exactValues: [String(number)] })).toEqual(expected);
	}, settings);
});

it('keeps the last value when redacted keys collide', () => {
	const input = { nested: { 'first-secret': 1, 'second-secret': 2 } };
	const options = { exactValues: ['first-secret', 'second-secret'] };
	expect(redactUpstreamResponse(input, options)).toEqual({ nested: { '[REDACTED]': 2 } });
	expect(redactUpstreamCatalogValue(input, options)).toEqual({ nested: { '[REDACTED]': 2 } });
});

it('redacts keys and whole numbers within error code, data and cause', () => {
	const error = new Error('failure', { cause: { 'secret-key': 42, other: 142 } });
	Object.defineProperty(error, 'code', { value: 42, enumerable: true });
	Object.defineProperty(error, 'data', {
		value: { 'secret-key': 42, other: 142 },
		enumerable: true,
	});
	const redacted = redactThrownError(error, { exactValues: ['secret-key', '42'] });
	expect(Object.getOwnPropertyDescriptor(redacted, 'code')?.value).toBe('[REDACTED]');
	expect(Object.getOwnPropertyDescriptor(redacted, 'data')?.value).toEqual({
		'[REDACTED]': '[REDACTED]',
		other: 142,
	});
	expect(redacted.cause).toEqual({ '[REDACTED]': '[REDACTED]', other: 142 });
});
