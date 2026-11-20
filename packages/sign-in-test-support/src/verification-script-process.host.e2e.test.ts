import { mkdtemp, readFile, open, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { runCommand } from '../../../scripts/verify-auth/verification-process';

it('closes the actual first log handle when acquiring the second log rejects', async (): Promise<void> => {
	const directory = await mkdtemp(path.join(tmpdir(), 'verify-log-open-failure-'));
	const prefix = path.join(directory, 'acquisition');
	await writeFile(`${prefix}.stderr.log`, 'reserved', { mode: 0o600 });
	const acquired: FileHandle[] = [];
	try {
		await expect(
			runCommand({
				executable: process.execPath,
				args: ['-e', 'process.exit(0)'],
				cwd: directory,
				env: process.env,
				logPrefix: prefix,
				openLog: async (file): Promise<FileHandle> => {
					const handle = await open(file, 'wx', 0o600);
					acquired.push(handle);
					return handle;
				},
			}),
		).rejects.toMatchObject({ code: 'EEXIST' });
		expect(acquired).toHaveLength(1);
		expect(acquired[0]?.fd).toBe(-1);
	} finally {
		await Promise.all(acquired.map((handle) => handle.close()));
	}
});

it('observes and stops an owned descendant after its parent exits while inherited output stays open', async (): Promise<void> => {
	const directory = await mkdtemp(path.join(tmpdir(), 'verify-owned-process-'));
	const descendant = `const net=require('node:net');net.createServer().listen(0,'127.0.0.1',()=>{process.stdout.write('descendant-ready');process.send('ready')});`;
	const parent = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2,'ipc']});child.once('message',()=>process.exit(0));`;
	const result = await runCommand({
		executable: process.execPath,
		args: ['-e', parent],
		cwd: directory,
		env: process.env,
		logPrefix: path.join(directory, 'parent'),
	});
	expect(result.code).toBe(0);
	expect(result.signal).toBeNull();
	if (result.leftAtExit === null) throw new Error('Process observation unexpectedly unavailable');
	expect(result.leftAtExit.length).toBeGreaterThan(0);
	expect(result.remaining).toEqual([]);
	expect(result.cleanup.kind).toBe('intervened');
	expect(result.cleanup.termination).toEqual({ kind: 'sent', signal: 'SIGTERM' });
	expect(await readFile(result.stdoutFile, 'utf8')).toBe('descendant-ready');
});

it('keeps cleanup unknown when observation fails instead of asserting no leftovers', async (): Promise<void> => {
	const directory = await mkdtemp(path.join(tmpdir(), 'verify-unknown-cleanup-'));
	const result = await runCommand({
		executable: process.execPath,
		args: ['-e', 'process.exit(0)'],
		cwd: directory,
		env: process.env,
		logPrefix: path.join(directory, 'observer-failure'),
		observeGroup: async (): Promise<
			readonly import('./test-fixtures/owned-process-group').OwnedProcessIdentity[]
		> => {
			throw new Error('Injected observation failure');
		},
	});
	expect(result.remaining).toBeNull();
	expect(result.leftAtExit).toBeNull();
});

it.each(['late', 'persistent', 'zombie'] as const)(
	'distinguishes %s descendants without forceful signals',
	async (kind): Promise<void> => {
		const directory = await mkdtemp(path.join(tmpdir(), 'verify-group-policy-'));
		const signals: (string | number | undefined)[] = [];
		const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, value): true => {
			signals.push(value);
			return true;
		});
		let reads = 0;
		try {
			const result = await runCommand({
				executable: process.execPath,
				args: ['-e', 'process.exit(0)'],
				cwd: directory,
				env: process.env,
				logPrefix: path.join(directory, 'policy'),
				observeGroup: async (group) => {
					reads += 1;
					return kind === 'late' && reads >= 3
						? []
						: [
								{
									pid: 123,
									parent: 122,
									group,
									command: 'synthetic-child',
									state: kind === 'zombie' ? 'Z' : 'S',
								},
							];
				},
			});
			expect(signals).toEqual(kind === 'persistent' ? ['SIGTERM'] : []);
			expect(result.cleanup.kind).toBe(kind === 'persistent' ? 'intervened' : 'natural');
			expect(result.remaining).toEqual(kind === 'persistent' ? [123] : []);
			expect(result.cleanup.reads.length).toBe(kind === 'late' ? 3 : kind === 'zombie' ? 1 : 10);
		} finally {
			signal.mockRestore();
		}
	},
);
