import {
	mkdir,
	mkdtemp,
	readFile,
	rmdir,
	unlink,
	writeFile,
	symlink,
	rm,
	realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
	applySecurityEdits,
	restoreSecurityEdits,
	type OriginalSource,
} from '../../../scripts/verify-auth/verification-runner';

it('retains caller custody of partial edits and attempts every restore even when one write fails', async (): Promise<void> => {
	const root = await mkdtemp(path.join(tmpdir(), 'verify-security-custody-'));
	const first = path.join(root, 'first.ts');
	const second = path.join(root, 'second.ts');
	await writeFile(first, 'first original');
	await writeFile(second, 'second original');
	const originals = new Map<string, OriginalSource>();
	await expect(
		applySecurityEdits(
			root,
			[
				{ kind: 'text', file: 'first.ts', find: 'first original', replace: 'first mutant' },
				{ kind: 'text', file: 'second.ts', find: 'absent site', replace: 'second mutant' },
			],
			originals,
		),
	).rejects.toThrow('exactly once');
	expect(await readFile(first, 'utf8')).toBe('first mutant');
	expect(
		[...originals].map(([name, original]) => [
			name,
			original.resolvedPath,
			original.bytes.toString('utf8'),
		]),
	).toEqual([
		['first.ts', path.join(await realpath(root), 'first.ts'), 'first original'],
		['second.ts', path.join(await realpath(root), 'second.ts'), 'second original'],
	]);

	// An actual unwritable destination, without permission-mode assumptions on the test user.
	await unlink(first);
	await mkdir(first);
	await writeFile(second, 'must be restored despite the first error');
	await expect(restoreSecurityEdits(root, originals)).rejects.toThrow('could not all be restored');
	expect(await readFile(second, 'utf8')).toBe('second original');
	expect(originals.get('first.ts')?.bytes.toString('utf8')).toBe('first original');

	await rmdir(first); // Only this test's own empty fault-fixture directory.
	await writeFile(first, 'retry destination');
	await restoreSecurityEdits(root, originals);
	expect(await readFile(first, 'utf8')).toBe('first original');
	expect(await readFile(second, 'utf8')).toBe('second original');
});

it.each(['leaf', 'parent'])(
	'refuses an edit through a %s symlink without changing its referent',
	async (kind): Promise<void> => {
		const parent = await mkdtemp(path.join(tmpdir(), 'verify-edit-links-'));
		try {
			const root = path.join(parent, 'source');
			const outside = path.join(parent, 'outside');
			await mkdir(root);
			await mkdir(outside);
			const referent = path.join(outside, 'guard.ts');
			await writeFile(referent, 'original guard');
			const relative = kind === 'leaf' ? 'guard.ts' : 'linked/guard.ts';
			await symlink(
				kind === 'leaf' ? referent : outside,
				path.join(root, kind === 'leaf' ? 'guard.ts' : 'linked'),
			);
			await expect(
				applySecurityEdits(
					root,
					[{ kind: 'text', file: relative, find: 'original guard', replace: 'mutant guard' }],
					new Map(),
				),
			).rejects.toThrow();
			expect(await readFile(referent, 'utf8')).toBe('original guard');
		} finally {
			await rm(parent, { recursive: true });
		}
	},
);

it('refuses a link substituted before restore and preserves the outside bytes', async (): Promise<void> => {
	const parent = await mkdtemp(path.join(tmpdir(), 'verify-restore-links-'));
	try {
		const root = path.join(parent, 'source');
		await mkdir(root);
		const guard = path.join(root, 'guard.ts');
		const outside = path.join(parent, 'outside.ts');
		await writeFile(guard, 'original guard');
		await writeFile(outside, 'outside bytes');
		const originals = new Map<string, OriginalSource>();
		await applySecurityEdits(
			root,
			[{ kind: 'text', file: 'guard.ts', find: 'original guard', replace: 'mutant guard' }],
			originals,
		);
		await unlink(guard);
		await symlink(outside, guard);
		await expect(restoreSecurityEdits(root, originals)).rejects.toThrow();
		expect(await readFile(outside, 'utf8')).toBe('outside bytes');
	} finally {
		await rm(parent, { recursive: true });
	}
});
