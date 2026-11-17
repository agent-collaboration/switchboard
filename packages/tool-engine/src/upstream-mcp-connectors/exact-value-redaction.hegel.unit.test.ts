import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it, vi } from 'vitest';

import {
	redactCredentialText,
	redactExactCredentialText,
	redactUpstreamCatalogValue,
	redactUpstreamResponse,
} from '#upstream-mcp-connectors/upstream-response-middleware';

const settings = {
	testCases: 500,
	seed: 20261117,
	derandomize: true,
	database: hegel.Database.disabled,
};
const marker = '[REDACTED]';

interface CoveredText {
	readonly redacted: string;
	readonly outsideSecrets: readonly string[];
}

// Independent oracle: mark matching character positions, then render covered runs.
// The product instead discovers intervals and merges them.
function coveredText(text: string, values: readonly string[]): CoveredText {
	const covered = Array.from({ length: text.length }, (): boolean => false);
	for (let start = 0; start < text.length; start += 1) {
		for (const value of values) {
			if (value.length === 0 || text.slice(start, start + value.length) !== value) continue;
			for (let offset = 0; offset < value.length; offset += 1) covered[start + offset] = true;
		}
	}
	let redacted = '';
	const outsideSecrets: string[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = cursor;
		const hidden = covered[cursor] === true;
		while (cursor < text.length && (covered[cursor] === true) === hidden) cursor += 1;
		if (hidden) redacted += marker;
		else {
			const ordinary = text.slice(start, cursor);
			redacted += ordinary;
			outsideSecrets.push(ordinary);
		}
	}
	return { redacted, outsideSecrets };
}

function assertNoNewSecretFragments(props: {
	readonly actual: string;
	readonly values: readonly string[];
	readonly outsideSecrets: readonly string[];
}): void {
	for (const value of props.values) {
		if (value.length > 0 && !props.outsideSecrets.some((ordinary) => ordinary.includes(value)))
			expect(props.actual).not.toContain(value);
		for (let offset = 0; offset <= value.length - 4; offset += 1) {
			const fragment = value.slice(offset, offset + 4);
			if (!props.outsideSecrets.some((ordinary) => ordinary.includes(fragment)))
				expect(props.actual).not.toContain(fragment);
		}
	}
}

it('redacts the minimal shorter-header-before-longer-credential example', () => {
	expect(
		redactExactCredentialText('key acme_live_9f8', { exactValues: ['acme', 'acme_live_9f8'] }),
	).toBe('key [REDACTED]');
});

it('redacts the union of substring, partial-overlap and adjacent secret occurrences in any order', () => {
	hegel.test((tc) => {
		const block = generators.text({
			alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789_-.é雪🔐🪐',
			minSize: 4,
			maxSize: 16,
		});
		const left = tc.draw(block);
		const middle = tc.draw(block);
		const right = tc.draw(block);
		const joined = `${left}${middle}${right}`;
		const cases = [
			{ text: `PUBLIC<${joined}>END`, values: [left, joined] },
			{ text: `PUBLIC<${joined}>END`, values: [`${left}${middle}`, `${middle}${right}`] },
			{ text: `PUBLIC<${joined}${joined}>END`, values: [`${left}${middle}`, right, joined] },
			{ text: `PUBLIC<${left.repeat(3)}>END`, values: [left.repeat(2)] },
		];
		for (const input of cases) {
			const expected = coveredText(input.text, input.values);
			tc.note(JSON.stringify(input));
			for (const values of [
				input.values,
				input.values.toReversed(),
				[...input.values, '', input.values[0] ?? ''],
			]) {
				const actual = redactExactCredentialText(input.text, { exactValues: values });
				const expectedKey = coveredText('nested', values).redacted;
				expect(actual).toBe(expected.redacted);
				assertNoNewSecretFragments({ actual, values, outsideSecrets: expected.outsideSecrets });
				expect(
					redactUpstreamCatalogValue({ nested: [input.text] }, { exactValues: values }),
				).toEqual({ [expectedKey]: [expected.redacted] });
				expect(redactUpstreamResponse({ nested: [input.text] }, { exactValues: values })).toEqual({
					[expectedKey]: [expected.redacted],
				});
			}
		}
	}, settings);
});

it('redacts the union wrapper key when a legal generated value also matches that key', () => {
	const values = ['nest', 'nest00000000'];
	const input = { nested: ['PUBLIC<nest00000000>END'] };
	const expected = { '[REDACTED]ed': ['PUBLIC<[REDACTED]>END'] };
	expect(coveredText('nested', values).redacted).toBe('[REDACTED]ed');
	expect(redactUpstreamCatalogValue(input, { exactValues: values })).toEqual(expected);
	expect(redactUpstreamResponse(input, { exactValues: values })).toEqual(expected);
});

it('matches independent character coverage for generated multi-value occurrence sets', () => {
	hegel.test((tc) => {
		const text = tc.draw(
			generators.text({
				alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789_-.é雪🔐🪐',
				minSize: 8,
				maxSize: 96,
			}),
		);
		const count = tc.draw(generators.integers({ minValue: 2, maxValue: 7 }));
		const values = Array.from({ length: count }, (): string => {
			const start = tc.draw(generators.integers({ minValue: 0, maxValue: text.length - 4 }));
			const length = tc.draw(
				generators.integers({ minValue: 4, maxValue: Math.min(24, text.length - start) }),
			);
			return text.slice(start, start + length);
		});
		const input = `PUBLIC<${text}>END`;
		const expected = coveredText(input, values);
		tc.note(JSON.stringify({ input, values }));
		const actual = redactExactCredentialText(input, { exactValues: values });
		expect(actual).toBe(expected.redacted);
		expect(redactExactCredentialText(input, { exactValues: values.toReversed() })).toBe(actual);
		assertNoNewSecretFragments({ actual, values, outsideSecrets: expected.outsideSecrets });
	}, settings);
});

it('redacts a complete exact credential containing a recognized pattern through recursive consumers', () => {
	for (const input of [
		{ text: 'prefix Bearer abcdefgh', value: 'prefix Bearer abcdefgh', expected: marker },
		{
			text: 'left prefix Bearer abcdef suffix right',
			value: 'prefix Bearer abcdef suffix',
			expected: `left ${marker} right`,
		},
	]) {
		const options = { exactValues: [input.value] };
		expect(redactCredentialText(input.text, options)).toBe(input.expected);
		for (const redact of [redactUpstreamResponse, redactUpstreamCatalogValue]) {
			expect(redact({ nested: [input.text] }, options)).toEqual({ nested: [input.expected] });
		}
	}
});

it('preserves complete pattern redaction when an exact value overlaps part of the pattern', () => {
	for (const input of [
		{ text: 'Bearer secret-token', values: ['secret'] },
		{ text: 'Basic c2VjcmV0', values: ['c2Vj'] },
		{ text: 'token=secret-value', values: ['secret'] },
	]) {
		expect(redactCredentialText(input.text, { exactValues: input.values })).toBe(marker);
	}
});

it('unions generated credential patterns and exact overlaps with astral text', () => {
	hegel.test((tc) => {
		const ordinary = generators.text({
			alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789_-.é雪🔐🪐',
			minSize: 4,
			maxSize: 16,
		});
		const credential = tc.draw(
			generators.text({
				alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789_-.',
				minSize: 8,
				maxSize: 32,
			}),
		);
		const prefix = `🔐${tc.draw(ordinary)} `;
		const suffix = ` ${tc.draw(ordinary)}🪐`;
		const split = tc.draw(generators.integers({ minValue: 1, maxValue: credential.length - 1 }));
		// Each template is a known pattern match, independent of the product's regexes.
		for (const scheme of ['Bearer ', 'Basic ', 'api_key=', 'token=', 'password=', 'secret=']) {
			const pattern = `${scheme}${credential}`;
			const input = `PUBLIC<${prefix}${pattern}${suffix}>END`;
			const valueSets = [
				[`${prefix}${scheme}${credential.slice(0, split)}`],
				[`${credential.slice(split)}${suffix}`],
				[`${prefix}${scheme}${credential.slice(0, split)}`, `${credential.slice(split)}${suffix}`],
			];
			for (const values of valueSets) {
				const expected = coveredText(input, [...values, pattern]);
				tc.note(JSON.stringify({ input, values, pattern }));
				for (const exactValues of [values, values.toReversed()]) {
					const actual = redactCredentialText(input, { exactValues });
					expect(actual).toBe(expected.redacted);
					assertNoNewSecretFragments({ actual, values, outsideSecrets: expected.outsideSecrets });
					expect(redactUpstreamResponse({ nested: [input] }, { exactValues })).toEqual({
						nested: [expected.redacted],
					});
				}
				// Catalog redaction remains exact-only even for pattern-shaped input.
				expect(redactUpstreamCatalogValue({ nested: [input] }, { exactValues: values })).toEqual({
					nested: [coveredText(input, values).redacted],
				});
			}
		}
	}, settings);
});

it('bounds buffered spans by contiguous runs for large repeated short header values', () => {
	const run = '2'.repeat(256 * 1024);
	const input = `PUBLIC<${run}>between<${run}>END`;
	const sorting = vi.spyOn(Array.prototype, 'sort');
	let bufferedSpanCounts: number[] = [];
	let actual = '';
	try {
		actual = redactExactCredentialText(input, { exactValues: ['2', '22', '2222'] });
		// Observe the actual collection entering the cross-value merge, without a public test API.
		bufferedSpanCounts = sorting.mock.contexts.map((spanCollection) => {
			if (!Array.isArray(spanCollection))
				throw new Error('Expected a span collection to be sorted.');
			return spanCollection.length;
		});
	} finally {
		sorting.mockRestore();
	}
	expect(actual).toBe(`PUBLIC<${marker}>between<${marker}>END`);
	expect(bufferedSpanCounts).toEqual([6]);
});
