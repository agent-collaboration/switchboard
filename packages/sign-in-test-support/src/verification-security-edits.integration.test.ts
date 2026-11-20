import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
	applySecurityEdits,
	restoreSecurityEdits,
} from '../../../scripts/verify-auth/verification-runner';

it('retains caller custody of partial edits and attempts every restore even when one write fails', async (): Promise<void> => {
	const root = await mkdtemp(path.join(tmpdir(), 'verify-security-custody-'));
	const first = path.join(root, 'first.ts');
	const second = path.join(root, 'second.ts');
	await writeFile(first, 'first original');
	await writeFile(second, 'second original');
	const originals = new Map<string, string>();
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
	expect([...originals]).toEqual([
		['first.ts', 'first original'],
		['second.ts', 'second original'],
	]);

	// An actual unwritable destination, without permission-mode assumptions on the test user.
	await unlink(first);
	await mkdir(first);
	await writeFile(second, 'must be restored despite the first error');
	await expect(restoreSecurityEdits(root, originals)).rejects.toThrow('could not all be restored');
	expect(await readFile(second, 'utf8')).toBe('second original');
	expect(originals.get('first.ts')).toBe('first original');

	await rmdir(first); // Only this test's own empty fault-fixture directory.
	await restoreSecurityEdits(root, originals);
	expect(await readFile(first, 'utf8')).toBe('first original');
	expect(await readFile(second, 'utf8')).toBe('second original');
});
