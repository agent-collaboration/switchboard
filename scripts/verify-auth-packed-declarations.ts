import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { z } from 'zod';

import { collectAuthCoreViolations } from './audit-portal-architecture.ts';
import {
	compareVendorDeclarationDiagnostics,
	drizzleDeclarationInventorySchema,
	forbiddenLoadedDeclarationFiles,
	type VendorDeclarationDiagnostic,
	type VendorDiagnosticComparison,
} from './auth-core-declaration-diagnostics.ts';

const inventoryRelativePath =
	'packages/sign-in-test-support/contract-fixtures/drizzle-0.45.2-declarations/drizzle-orm-0.45.2-diagnostics.json';
const coreCompilerOptions = {
	target: ts.ScriptTarget.ES2024,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	strict: true,
	exactOptionalPropertyTypes: true,
	noEmit: true,
	skipLibCheck: false,
	types: [],
	lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'],
} satisfies ts.CompilerOptions;

interface CoreDeclarationObservation {
	readonly firstParty: readonly ts.Diagnostic[];
	readonly vendor: readonly VendorDeclarationDiagnostic[];
	readonly comparison: VendorDiagnosticComparison;
	readonly forbiddenFiles: readonly string[];
	readonly forbiddenImports: readonly string[];
}
function accepted(observation: CoreDeclarationObservation): boolean {
	return (
		observation.firstParty.length === 0 &&
		observation.comparison.kind === 'matched' &&
		observation.forbiddenFiles.length === 0 &&
		observation.forbiddenImports.length === 0
	);
}

async function observeCoreDeclarations(
	program: ts.Program,
	authRoot: string,
	vendorRoot: string,
	expected: readonly VendorDeclarationDiagnostic[],
): Promise<CoreDeclarationObservation> {
	const partitioned = await Promise.all(
		ts.getPreEmitDiagnostics(program).map(async (diagnostic) => {
			if (diagnostic.file === undefined) return { kind: 'first-party', diagnostic } as const;
			const file = await realpath(diagnostic.file.fileName);
			if (!file.startsWith(vendorRoot + path.sep))
				return { kind: 'first-party', diagnostic } as const;
			return {
				kind: 'vendor',
				diagnostic: {
					file: 'drizzle-orm/' + path.relative(vendorRoot, file).split(path.sep).join('/'),
					code: diagnostic.code,
					message: ts
						.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
						.split(vendorRoot)
						.join('drizzle-orm'),
				},
			} as const;
		}),
	);
	const vendor = partitioned.flatMap((entry) =>
		entry.kind === 'vendor' ? [entry.diagnostic] : [],
	);
	const firstParty = partitioned.flatMap((entry) =>
		entry.kind === 'first-party' ? [entry.diagnostic] : [],
	);
	const closure = program
		.getSourceFiles()
		.filter((file) => file.fileName.startsWith(authRoot + path.sep));
	if (closure.length === 0) throw new Error('Empty packed core declaration closure');
	return {
		firstParty,
		vendor,
		comparison: compareVendorDeclarationDiagnostics(vendor, expected),
		forbiddenFiles: forbiddenLoadedDeclarationFiles(
			program.getSourceFiles().map((file) => file.fileName),
		),
		forbiddenImports: closure.flatMap((file) =>
			collectAuthCoreViolations({
				filePath:
					'packages/sign-in-core/src/' +
					path.relative(path.join(authRoot, 'dist'), file.fileName).split(path.sep).join('/'),
				sourceText: file.text,
			}),
		),
	};
}

/** Keeps strict library checking; only the exact pinned vendor inventory is expected. */
export async function verifyPackedAuthDeclarations(props: {
	readonly repositoryRoot: string;
	readonly scratch: string;
	readonly evidence: string;
	readonly authRoot: string;
}): Promise<void> {
	const inventory = drizzleDeclarationInventorySchema.parse(
		JSON.parse(await readFile(path.join(props.repositoryRoot, inventoryRelativePath), 'utf8')),
	);
	function coreProgram(): ts.Program {
		return ts.createProgram([path.join(props.scratch, 'core-consumer.ts')], {
			...coreCompilerOptions,
			typeRoots: [path.join(props.scratch, 'node_modules/@types')],
		});
	}
	const program = coreProgram();
	const columnBuilder = program
		.getSourceFiles()
		.find((file) => file.fileName.endsWith('/drizzle-orm/column-builder.d.ts'));
	if (columnBuilder === undefined)
		throw new Error('Packed core did not load the pinned Drizzle declarations');
	const vendorRoot = await realpath(path.dirname(columnBuilder.fileName));
	const vendorManifest = z
		.object({ name: z.literal('drizzle-orm'), version: z.string() })
		.parse(JSON.parse(await readFile(path.join(vendorRoot, 'package.json'), 'utf8')));
	const baseline = await observeCoreDeclarations(
		program,
		props.authRoot,
		vendorRoot,
		inventory.diagnostics,
	);
	await writeFile(
		path.join(props.evidence, 'core-vendor-actual.json'),
		JSON.stringify(
			{
				vendor: inventory.vendor,
				version: vendorManifest.version,
				typescript: ts.version,
				diagnostics: baseline.vendor,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(props.evidence, 'core-declaration-gate.json'),
		JSON.stringify({
			comparison: baseline.comparison,
			firstPartyDiagnostics: baseline.firstParty.length,
			forbiddenFiles: baseline.forbiddenFiles,
			forbiddenImports: baseline.forbiddenImports,
		}),
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(props.evidence, 'core-declarations.log'),
		ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: () => props.scratch,
			getNewLine: () => '\n',
		}),
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(props.evidence, 'core-declaration-graph.json'),
		JSON.stringify(program.getSourceFiles().map((file) => file.fileName)),
		{ mode: 0o600 },
	);
	if (ts.version !== inventory.typescript || vendorManifest.version !== inventory.version)
		throw new Error(
			'Packed declaration compiler/vendor version differs from the pinned inventory; private actual diagnostics: ' +
				props.evidence,
		);
	if (!accepted(baseline))
		throw new Error(
			'Packed core declarations or exact vendor inventory failed; private evidence: ' +
				props.evidence,
		);
	const first = baseline.vendor[0];
	if (first === undefined) throw new Error('Missing pinned vendor diagnostic control input');
	const exactnessControls = [
		{
			name: 'added',
			comparison: compareVendorDeclarationDiagnostics(
				[...baseline.vendor, { ...first, message: first.message + ' added control' }],
				inventory.diagnostics,
			),
		},
		{
			name: 'removed',
			comparison: compareVendorDeclarationDiagnostics(
				baseline.vendor.slice(1),
				inventory.diagnostics,
			),
		},
		{
			name: 'changed',
			comparison: compareVendorDeclarationDiagnostics(
				[{ ...first, message: first.message + ' changed control' }, ...baseline.vendor.slice(1)],
				inventory.diagnostics,
			),
		},
	];
	await writeFile(
		path.join(props.evidence, 'vendor-inventory-controls.json'),
		JSON.stringify(exactnessControls),
		{ mode: 0o600 },
	);
	if (exactnessControls.some((control) => control.comparison.kind !== 'mismatched'))
		throw new Error('Exact vendor inventory sensitivity control survived');

	// Atomic replacement breaks a possible pnpm hard link before any mutation.
	// Only this newly packed, owned scratch package is changed, never the store.
	const scratchRoot = await realpath(props.scratch);
	if (!props.authRoot.startsWith(scratchRoot + path.sep))
		throw new Error('Declaration controls require a private packed package');
	const declaration = path.join(props.authRoot, 'dist/index.d.ts');
	const original = await readFile(declaration, 'utf8');
	const mode = (await stat(declaration)).mode & 0o777;
	async function replaceDeclaration(contents: string, label: string): Promise<void> {
		const temporary = declaration + '.' + label + '.control';
		await writeFile(temporary, contents, { mode, flag: 'wx' });
		await rename(temporary, declaration);
	}
	const controls = [
		{
			name: 'broken-published-type',
			source: '\nexport type AuthCoreBrokenPublishedControl = MissingAuthCorePublishedControl;\n',
			expected: 'first-party',
		},
		{
			name: 'node-import',
			source:
				'\nimport type { Stats as AuthCoreNodeControl } from "node:fs"; export type AuthCorePublishedNodeControl = AuthCoreNodeControl;\n',
			expected: 'forbidden-import',
		},
		{
			name: 'driver-import',
			source:
				'\nimport type { DrizzleD1Database as AuthCoreDriverControl } from "drizzle-orm/d1"; export type AuthCorePublishedDriverControl = AuthCoreDriverControl;\n',
			expected: 'forbidden-import',
		},
	] as const;
	const controlResults: {
		readonly name: string;
		readonly rejected: boolean;
		readonly intendedFailure: boolean;
		readonly firstPartyCodes: readonly number[];
		readonly forbiddenImports: readonly string[];
		readonly forbiddenFiles: readonly string[];
	}[] = [];
	// All controls replace the same private file, so execute them in order.
	async function runDeclarationControls(
		remaining: readonly (typeof controls)[number][],
	): Promise<void> {
		const control = remaining[0];
		if (control === undefined) return;
		try {
			await replaceDeclaration(original + control.source, control.name);
			const observation = await observeCoreDeclarations(
				coreProgram(),
				props.authRoot,
				vendorRoot,
				inventory.diagnostics,
			);
			const intendedFailure =
				control.expected === 'first-party'
					? observation.firstParty.some(
							(diagnostic) => diagnostic.code === 2304 && diagnostic.file?.fileName === declaration,
						)
					: observation.forbiddenImports.some((violation) =>
							violation.includes(control.name === 'node-import' ? 'node:fs' : 'drizzle-orm/d1'),
						);
			controlResults.push({
				name: control.name,
				rejected: !accepted(observation),
				intendedFailure,
				firstPartyCodes: observation.firstParty.map((diagnostic) => diagnostic.code),
				forbiddenImports: observation.forbiddenImports,
				forbiddenFiles: observation.forbiddenFiles,
			});
		} finally {
			await replaceDeclaration(original, control.name + '-restored');
		}
		await runDeclarationControls(remaining.slice(1));
	}
	await runDeclarationControls(controls);
	await writeFile(
		path.join(props.evidence, 'core-declaration-controls.json'),
		JSON.stringify(controlResults),
		{ mode: 0o600 },
	);
	if (controlResults.some((control) => !control.rejected || !control.intendedFailure))
		throw new Error('Published core declaration control did not fail for its intended reason');
	const restored = await observeCoreDeclarations(
		coreProgram(),
		props.authRoot,
		vendorRoot,
		inventory.diagnostics,
	);
	if (!accepted(restored) || (await readFile(declaration, 'utf8')) !== original)
		throw new Error('Packed core declaration controls did not restore the accepted baseline');
	await writeFile(
		path.join(props.evidence, 'core-declaration-restored.json'),
		JSON.stringify({ accepted: true, knownVendorDiagnostics: restored.vendor.length }),
		{ mode: 0o600 },
	);

	const cloudflareProgram = ts.createProgram([path.join(props.scratch, 'cloudflare-consumer.ts')], {
		...coreCompilerOptions,
		skipLibCheck: true,
		types: ['node'],
		lib: ['lib.es2024.d.ts'],
		typeRoots: [path.join(props.scratch, 'node_modules/@types')],
	});
	const cloudflareDiagnostics = ts.getPreEmitDiagnostics(cloudflareProgram);
	await writeFile(
		path.join(props.evidence, 'cloudflare-declarations.log'),
		ts.formatDiagnosticsWithColorAndContext(cloudflareDiagnostics, {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: () => props.scratch,
			getNewLine: () => '\n',
		}),
		{ mode: 0o600 },
	);
	if (cloudflareDiagnostics.length !== 0)
		throw new Error(
			'Packed Cloudflare declaration consumer failed; private evidence: ' + props.evidence,
		);
}
