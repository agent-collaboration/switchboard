import { readFile } from 'node:fs/promises';

import ts from 'typescript';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';

useControlledSignInClock();

it('production Worker composes only the ordinary HTTP and named management factories without an observer', async () => {
	const contents = await readFile(
		new URL('../../sign-in-host-cloudflare/src/index.ts', import.meta.url),
		'utf8',
	);
	const source = ts.createSourceFile(
		'production-worker.ts',
		contents,
		ts.ScriptTarget.Latest,
		true,
	);
	const calls: { readonly factory: string; readonly argumentCount: number }[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			['createSignInManagementBinding', 'createSignInHttpHandler'].includes(node.expression.text)
		) {
			// The HTTP handler's only admitted second argument is the after-response hook literal.
			const options = node.arguments[1];
			const onlyAfterResponseHook =
				node.expression.text === 'createSignInHttpHandler' &&
				options !== undefined &&
				ts.isObjectLiteralExpression(options) &&
				options.properties.length === 1 &&
				options.properties[0]?.name !== undefined &&
				ts.isIdentifier(options.properties[0].name) &&
				options.properties[0].name.text === 'deferAfterResponse';
			calls.push({
				factory: node.expression.text,
				argumentCount: node.arguments.length - (onlyAfterResponseHook ? 1 : 0),
			});
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	expect(calls.map((call) => call.factory)).toEqual(
		expect.arrayContaining(['createSignInManagementBinding', 'createSignInHttpHandler']),
	);
	expect(calls.every((call) => call.argumentCount === 1)).toBe(true);
	expect(contents).not.toMatch(/observeManagement|management-observation-holds|test-fixtures/u);
});
