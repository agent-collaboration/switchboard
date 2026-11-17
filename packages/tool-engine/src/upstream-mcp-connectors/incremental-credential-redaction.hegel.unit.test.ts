import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	createCredentialTextRedactor,
	maximumPendingCredentialPatternCharacters,
} from '#upstream-mcp-connectors/incremental-credential-redaction';
import { redactCredentialText } from '#upstream-mcp-connectors/upstream-response-middleware';

const settings = {
	testCases: 500,
	seed: 20261117,
	derandomize: true,
	database: hegel.Database.disabled,
};

it('matches batch redaction for generated text and arbitrary character partitions without overflow', () => {
	hegel.test((tc) => {
		const ordinary = tc.draw(
			generators.text({ alphabet: 'ab BasiCer_token=/.é雪🔐🪐', minSize: 0, maxSize: 48 }),
		);
		const credential = tc.draw(
			generators.text({
				alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789',
				minSize: 4,
				maxSize: 24,
			}),
		);
		const opaque = `opaque-${credential}🔐`;
		const valueSets = [
			[],
			[opaque],
			[opaque, 'abcde', 'efghij'],
			['', opaque, opaque, 'abcde', 'efghij', '1'],
		];
		const exactValues = valueSets[tc.draw(generators.integers({ minValue: 0, maxValue: 3 }))] ?? [];
		const input = [
			ordinary,
			`Bearer Bearer ${credential}`,
			`Bearer Basic ${credential}`,
			`Basic Bearer ${credential}`,
			`api_key=${credential}`,
			`token=Bearer ${credential}`,
			opaque,
			'abcdefghij',
		].join(' | ');
		const redactor = createCredentialTextRedactor({ exactValues });
		const output: string[] = [];
		const lengths: number[] = [];
		let cursor = 0;
		while (cursor < input.length) {
			const length = tc.draw(generators.integers({ minValue: 1, maxValue: 16 }));
			lengths.push(length);
			output.push(redactor.write(input.slice(cursor, cursor + length)));
			cursor += length;
		}
		output.push(redactor.end());
		tc.note(JSON.stringify({ input, exactValues, lengths }));
		expect(output.join('')).toBe(redactCredentialText(input, { exactValues }));
		expect(redactor.end()).toBe('');
	}, settings);
});

it('does not retain complete ordinary diagnostic lines until EOF', () => {
	const redactor = createCredentialTextRedactor({
		exactValues: ['absent-configured-secret-value'],
	});
	expect(redactor.write('controlled-cancelled\n')).toBe('controlled-cancelled\n');
	expect(redactor.end()).toBe('');
});

it('fails closed when an unresolved authorization prefix exceeds its named cap', () => {
	for (const ending of ['synthetic-token after', '! after']) {
		const redactor = createCredentialTextRedactor({ exactValues: ['synthetic-token'] });
		const prefix = `Bearer ${' '.repeat(maximumPendingCredentialPatternCharacters + 1)}`;
		expect(redactor.write(prefix)).toBe('[REDACTED]');
		const output = `[REDACTED]${redactor.write(ending)}${redactor.end()}`;
		expect(output).toBe(ending.startsWith('!') ? '[REDACTED]! after' : '[REDACTED] after');
		expect(output).not.toContain('Bearer');
		expect(output).not.toContain('synthetic-token');
	}
});

it('retains original exact overlap context even when a pattern exceeds the cap', () => {
	const secret = `${' '.repeat(maximumPendingCredentialPatternCharacters + 10)}opaque`;
	const redactor = createCredentialTextRedactor({ exactValues: [secret] });
	const output = [
		redactor.write(`Bearer ${secret.slice(0, -3)}`),
		redactor.write('que'),
		redactor.end(),
	];
	expect(output.join('')).toBe('[REDACTED]');
});

it('leaks no generated configured value or fragment across partitioned overflow and continuation', () => {
	hegel.test((tc) => {
		const credential = `opaque-${tc.draw(
			generators.text({
				alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789',
				minSize: 4,
				maxSize: 24,
			}),
		)}🔐`;
		const extra = tc.draw(generators.integers({ minValue: 1, maxValue: 128 }));
		const prefix = `left Bearer ${' '.repeat(maximumPendingCredentialPatternCharacters + extra)}`;
		const redactor = createCredentialTextRedactor({
			exactValues: [credential, credential.slice(0, 5)],
		});
		const output: string[] = [];
		let cursor = 0;
		while (cursor < prefix.length) {
			const length = tc.draw(generators.integers({ minValue: 64, maxValue: 257 }));
			output.push(redactor.write(prefix.slice(cursor, cursor + length)));
			cursor += length;
		}
		// The cap was reached before any value arrived; it already emitted its marker.
		expect(output.join('')).toBe('left [REDACTED]');
		const continuation = `${credential} after`;
		cursor = 0;
		while (cursor < continuation.length) {
			const length = tc.draw(generators.integers({ minValue: 1, maxValue: 12 }));
			output.push(redactor.write(continuation.slice(cursor, cursor + length)));
			cursor += length;
		}
		output.push(redactor.end());
		const actual = output.join('');
		tc.note(JSON.stringify({ credential, extra }));
		expect(actual).toBe('left [REDACTED] after');
		expect(actual).not.toContain(credential);
		for (let offset = 0; offset <= credential.length - 4; offset += 1) {
			const fragment = credential.slice(offset, offset + 4);
			if (!'left  after'.includes(fragment)) expect(actual).not.toContain(fragment);
		}
	}, settings);
});
