import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	canonicalCallArguments,
	hashCallArguments,
} from '#tool-access/contracts/call-argument-digest';

it('canonicalizes JSON object order and omissions while binding values and array order', async () => {
	await hegel.testAsync(
		async (tc) => {
			const value = tc.draw(generators.integers({ minValue: 1, maxValue: 100000 }));
			const text = tc.draw(generators.sampledFrom(['雪', 'é', 'quote"', '\\', '🐈']));
			tc.note(`value=${value} text=${JSON.stringify(text)}`);
			const input = { z: [value, text], a: { x: value, y: null } };
			const reordered = { a: { y: null, x: value, omitted: undefined }, z: [value, text] };
			expect(canonicalCallArguments(input)).toBe(canonicalCallArguments(reordered));
			const digest = await hashCallArguments(input);
			expect(await hashCallArguments(reordered)).toBe(digest);
			expect(await hashCallArguments({ ...input, z: [text, value] })).not.toBe(digest);
			expect(await hashCallArguments({ ...input, a: { ...input.a, x: value + 1 } })).not.toBe(
				digest,
			);
		},
		{ testCases: 500, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
});
