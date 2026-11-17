import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { describe, expect, it } from 'vitest';

import { createGogOperationResolver, type GogCommandDescriptorInput } from './gog-commands.js';
import { normalizeGogFileArgument } from './gog-file-paths.js';

const propertySettings = {
	testCases: 500,
	derandomize: true,
	database: hegel.Database.disabled,
};

const descriptorBase = {
	operationId: 'drive.transfer',
	familyId: 'documents',
	paths: [['drive', 'transfer']],
	requirements: [{ serviceId: 'drive', effects: ['read', 'write'] }],
	sendsMail: false,
	positionals: { minimum: 0, maximum: 0 },
	flags: [],
} satisfies GogCommandDescriptorInput;

interface RelativeFileCase {
	readonly rawPath: string;
	readonly relativePath: string;
}

function drawRelativeFile(testCase: hegel.TestCase): RelativeFileCase {
	const segments = testCase.draw(
		generators.arrays(generators.text({ alphabet: 'ab09 ._%=資料é', minSize: 0, maxSize: 12 }), {
			minSize: 1,
			maxSize: 32,
		}),
	);
	// Fixed segment edges keep spaces and dots internal, independently of the normalizer.
	const relativePath = segments.map((segment: string): string => `f${segment}x`).join('/');
	const prefix = testCase.draw(generators.sampledFrom(['', './']));
	return { rawPath: `${prefix}${relativePath}`, relativePath };
}

function fileFlag(props: {
	readonly direction: 'input' | 'output';
	readonly pathKind: 'file' | 'directory';
}): GogCommandDescriptorInput['flags'][number] {
	return {
		name: '--path',
		aliases: ['--destination', '-p'],
		kind: 'file-path',
		direction: props.direction,
		pathKind: props.pathKind,
		required: true,
	};
}

describe('P4 raw Gog argv and normalized file metadata', () => {
	it('preserves raw argv while resolving positional, input-flag and output-file metadata', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const pathCase = drawRelativeFile(testCase);
			const spelling = testCase.draw(generators.sampledFrom(['--path', '--destination', '-p']));
			const inline = testCase.draw(generators.booleans());
			const flagArgv = inline ? [`${spelling}=${pathCase.rawPath}`] : [spelling, pathCase.rawPath];
			testCase.note(JSON.stringify({ ...pathCase, spelling, inline }));

			for (const mode of ['positional', 'input', 'output'] satisfies readonly string[]) {
				const descriptor: GogCommandDescriptorInput =
					mode === 'positional'
						? {
								...descriptorBase,
								positionals: { minimum: 1, maximum: 1, fileInputs: [0] },
							}
						: {
								...descriptorBase,
								flags: [
									fileFlag({ direction: mode === 'input' ? 'input' : 'output', pathKind: 'file' }),
								],
							};
				const argv = Object.freeze([
					'drive',
					'transfer',
					...(mode === 'positional' ? ['--', pathCase.rawPath] : flagArgv),
				]);
				const originalArgv = [...argv];
				const resolve = createGogOperationResolver([descriptor]);

				// Act: only executable argv enters the resolver, including on the second call.
				const result = resolve(argv);

				// Assert
				expect(normalizeGogFileArgument(pathCase.rawPath, 'file')).toBe(pathCase.relativePath);
				expect(result).toEqual({
					kind: 'oauth',
					operationId: 'drive.transfer',
					familyId: 'documents',
					requirements: descriptorBase.requirements,
					sendsMail: false,
					files: {
						inputs: mode === 'output' ? [] : [pathCase.relativePath],
						outputs:
							mode === 'output' ? [{ relativePath: pathCase.relativePath, kind: 'file' }] : [],
					},
				});
				expect(resolve(argv)).toEqual(result);
				expect(argv).toEqual(originalArgv);
			}
		}, propertySettings);
	});

	it('allows root output directories and preserves directory metadata without rewriting argv', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const pathCase = drawRelativeFile(testCase);
			const resolve = createGogOperationResolver([
				{
					...descriptorBase,
					flags: [fileFlag({ direction: 'output', pathKind: 'directory' })],
				},
			]);
			const trailingSlash = testCase.draw(generators.sampledFrom(['', '/']));
			const directories = [
				{ rawPath: '.', relativePath: '' },
				{ rawPath: './', relativePath: '' },
				{ rawPath: `${pathCase.rawPath}${trailingSlash}`, relativePath: pathCase.relativePath },
			];
			testCase.note(JSON.stringify(directories));

			for (const directory of directories) {
				const argv = Object.freeze(['drive', 'transfer', `--path=${directory.rawPath}`]);
				const originalArgv = [...argv];
				// Act / Assert
				expect(normalizeGogFileArgument(directory.rawPath, 'directory')).toBe(
					directory.relativePath,
				);
				expect(resolve(argv)).toMatchObject({
					kind: 'oauth',
					files: {
						inputs: [],
						outputs: [{ relativePath: directory.relativePath, kind: 'directory' }],
					},
				});
				expect(argv).toEqual(originalArgv);
			}
		}, propertySettings);
	});

	it('refuses directory-only values as files and refuses input-directory descriptors', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const pathCase = drawRelativeFile(testCase);
			const directoryOnly = ['.', './', `${pathCase.rawPath}/`];
			const positionalResolver = createGogOperationResolver([
				{ ...descriptorBase, positionals: { minimum: 1, maximum: 1, fileInputs: [0] } },
			]);
			testCase.note(JSON.stringify({ directoryOnly }));

			// Act / Assert: './' is present in every case so the P4 wrong build cannot evade it.
			for (const rawPath of directoryOnly) {
				expect(normalizeGogFileArgument(rawPath, 'file')).toBeUndefined();
				expect(positionalResolver(['drive', 'transfer', '--', rawPath])).toEqual({
					kind: 'denied',
				});
				for (const direction of ['input', 'output'] satisfies readonly ('input' | 'output')[]) {
					const resolve = createGogOperationResolver([
						{ ...descriptorBase, flags: [fileFlag({ direction, pathKind: 'file' })] },
					]);
					expect(resolve(['drive', 'transfer', '--path', rawPath])).toEqual({ kind: 'denied' });
				}
			}
			expect((): unknown =>
				createGogOperationResolver([
					{ ...descriptorBase, flags: [fileFlag({ direction: 'input', pathKind: 'directory' })] },
				]),
			).toThrow('Gog input directories are not admitted.');
		}, propertySettings);
	});

	it('refuses unsafe raw path spellings before producing file metadata', () => {
		hegel.test((testCase: hegel.TestCase): void => {
			// Arrange
			const pathCase = drawRelativeFile(testCase);
			const rawPath = testCase.draw(
				generators.sampledFrom([
					'',
					'-',
					`/${pathCase.relativePath}`,
					`~/${pathCase.relativePath}`,
					`$HOME/${pathCase.relativePath}`,
					`../${pathCase.relativePath}`,
					`./../${pathCase.relativePath}`,
					`a//${pathCase.relativePath}`,
					`././${pathCase.relativePath}`,
					`a\\${pathCase.relativePath}`,
					` ${pathCase.relativePath}`,
					`${pathCase.relativePath} `,
					`a\0${pathCase.relativePath}`,
					`a\n${pathCase.relativePath}`,
					`${'é'.repeat(128)}/file`,
					`${'a/'.repeat(32)}file`,
				]),
			);
			const resolve = createGogOperationResolver([
				{ ...descriptorBase, positionals: { minimum: 1, maximum: 1, fileInputs: [0] } },
			]);
			testCase.note(JSON.stringify({ rawPath }));
			// Act / Assert
			expect(normalizeGogFileArgument(rawPath, 'file')).toBeUndefined();
			expect(normalizeGogFileArgument(rawPath, 'directory')).toBeUndefined();
			expect(resolve(['drive', 'transfer', '--', rawPath])).toEqual({ kind: 'denied' });
		}, propertySettings);
	});
});
