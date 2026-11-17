import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import type { Tool } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';

import { paginateMcpTools } from '#mcp-gateway/agent-catalog-views/tool-list-pagination';

it('reconstructs generated multipage lists within the independently serialized UTF-8 budget', () => {
	hegel.test(
		(tc) => {
			const count = tc.draw(generators.integers({ minValue: 4, maxValue: 7 }));
			const length = tc.draw(generators.integers({ minValue: 140000, maxValue: 160000 }));
			const character = tc.draw(generators.sampledFrom(['雪', '🐈', '"', '\\']));
			tc.note(`count=${count} length=${length} character=${JSON.stringify(character)}`);
			const tools: Tool[] = Array.from({ length: count }, (_, index) => ({
				name: `tool-${index}`,
				description: character.repeat(length),
				inputSchema: { type: 'object' },
			}));
			const seen: Tool[] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = paginateMcpTools(tools, cursor);
				const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
				expect(bytes).toBeLessThanOrEqual(1024 * 1024);
				expect(page.tools.length).toBeGreaterThan(0);
				seen.push(...page.tools);
				if (page.nextCursor !== undefined) {
					const next = tools[seen.length];
					if (next === undefined) throw new Error('Missing next tool');
					const candidate = {
						...page,
						tools: [...page.tools, next],
						...(seen.length + 1 === tools.length
							? { nextCursor: undefined }
							: { nextCursor: String(seen.length + 1) }),
					};
					expect(new TextEncoder().encode(JSON.stringify(candidate)).byteLength).toBeGreaterThan(
						1024 * 1024,
					);
				}
				cursor = page.nextCursor;
				pages += 1;
				expect(pages).toBeLessThanOrEqual(count);
			} while (cursor !== undefined);
			expect(pages).toBeGreaterThan(1);
			expect(seen).toEqual(tools);
			expect(() =>
				paginateMcpTools([
					{
						name: 'oversized',
						inputSchema: { type: 'object' },
						description: '雪'.repeat(350000 + count),
					},
				]),
			).toThrow();
			expect(() => paginateMcpTools(tools, `0${count}`)).toThrow();
			expect(() => paginateMcpTools(tools, String(count + 1))).toThrow();
		},
		{ testCases: 500, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
});
