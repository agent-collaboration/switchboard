import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import { encodeToolRef, decodeToolRef } from '#mcp-gateway/agent-catalog-views/tool-ref';

it('round trips nonempty Unicode identities and distinguishes changed components', () => {
	hegel.test(
		(tc) => {
			const prefix = tc.draw(
				generators.sampledFrom(['雪', 'é', 'e\u0301', '\uFEFF', '\u0000', ': /', '🐈']),
			);
			const value = tc.draw(generators.integers({ minValue: 0, maxValue: 100000 }));
			const identity = { namespace: `${prefix}${value}`, toolName: `tool:${prefix}${value}` };
			tc.note(`identity=${JSON.stringify(identity)}`);
			const ref = encodeToolRef(identity);
			expect(decodeToolRef(ref)).toEqual(identity);
			expect(encodeToolRef({ ...identity, namespace: `${identity.namespace}x` })).not.toBe(ref);
			expect(encodeToolRef({ ...identity, toolName: `${identity.toolName}x` })).not.toBe(ref);
			expect(() => decodeToolRef(`${ref}=`)).toThrow();
		},
		{ testCases: 500, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
});
