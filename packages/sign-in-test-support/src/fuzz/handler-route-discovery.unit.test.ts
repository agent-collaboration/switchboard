import ts from 'typescript';
import { expect, it } from 'vitest';

import {
	discoverHandlerRoutes,
	discoverRoutesInSource,
	unclassifiedHandlerRoutes,
} from '#sign-in-test-support/fuzz/handler-route-discovery';
import { routeClassification } from '#sign-in-test-support/fuzz/route-classification';

it('discovers pathname comparisons, route tables and prefixes', () => {
	const routes = discoverHandlerRoutes(
		`if (pathname === '/one' || '/two' === url.pathname) {}\n` +
			`if (pathname.startsWith('/group/')) {}\n` +
			`if (['/three', '/four'].includes(url.pathname)) {}\n` +
			`switch (url.pathname) { case '/five': break; default: break; }`,
		'handler.ts',
	);
	expect(routes).toEqual({
		paths: ['/five', '/four', '/one', '/three', '/two'],
		prefixes: ['/group/'],
	});
});

it('reports a newly discovered route and prefix missing from the classification', () => {
	const discovered = discoverHandlerRoutes(
		"if (pathname === '/known' || pathname === '/new') {} if (pathname.startsWith('/new-group/')) {}",
		'handler.ts',
	);
	expect(unclassifiedHandlerRoutes(discovered, ['/known'])).toEqual({
		paths: ['/new'],
		prefixes: ['/new-group/'],
	});
});

it('resolves the actual handler imported literal route through the compiler', () => {
	const configPath = 'packages/sign-in-core/tsconfig.json';
	const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
	expect(config.error).toBeUndefined();
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'packages/sign-in-core');
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const source = program.getSourceFile(
		'packages/sign-in-core/src/better-auth/sign-in-http-handler.ts',
	);
	if (source === undefined) throw new Error('Sign-in HTTP handler source not found');
	const routes = discoverRoutesInSource(source, program.getTypeChecker());
	expect(routes.paths).toContain('/organization-admin');
});

it('covers every pathname branch and prefix in the actual outer handlers', () => {
	const config = ts.readConfigFile('packages/sign-in-core/tsconfig.json', (path) =>
		ts.sys.readFile(path),
	);
	if (config.error !== undefined)
		throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'packages/sign-in-core');
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const classifiedPaths = routeClassification.map((row) => row.path);
	for (const file of [
		'packages/sign-in-core/src/response-release/sign-in-request-handler.ts',
		'packages/sign-in-core/src/better-auth/sign-in-http-handler.ts',
	]) {
		const source = program.getSourceFile(file);
		if (source === undefined) throw new Error(`Handler source not found: ${file}`);
		const discovered = discoverRoutesInSource(source, program.getTypeChecker());
		expect(unclassifiedHandlerRoutes(discovered, classifiedPaths)).toEqual({
			paths: [],
			prefixes: [],
		});
	}
});

it.each([
	'pathname === route',
	'url.pathname.startsWith(prefix)',
	'routes.includes(pathname)',
	"['/one', other].includes(pathname)",
])('refuses an unresolved pathname route: %s', (expression) => {
	expect(() => discoverHandlerRoutes(`if (${expression}) {}`, 'handler.ts')).toThrow(
		/Non-literal pathname/,
	);
});

it('accepts immutable literal constants and rejects computed or mutable constants', () => {
	const fileName = '/handler.ts';
	for (const [declaration, accepted] of [
		["const route = '/fixed'", true],
		["let route = '/mutable'", false],
		["const route = '/a' + '/b'", false],
	] satisfies readonly (readonly [string, boolean])[]) {
		const source = ts.createSourceFile(
			fileName,
			`${declaration}; if (pathname === route) {}`,
			ts.ScriptTarget.Latest,
			true,
		);
		const host = ts.createCompilerHost({ noLib: true });
		host.getSourceFile = (name: string): ts.SourceFile | undefined =>
			name === fileName ? source : undefined;
		const checker = ts.createProgram([fileName], { noLib: true }, host).getTypeChecker();
		if (accepted) expect(discoverRoutesInSource(source, checker).paths).toEqual(['/fixed']);
		else expect(() => discoverRoutesInSource(source, checker)).toThrow(/Non-literal pathname/);
	}
});
