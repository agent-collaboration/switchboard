import { spawn } from 'node:child_process';
import { open, readFile, type FileHandle } from 'node:fs/promises';

import type { ProcessResult } from './verification-decisions';

export interface CommandResult extends ProcessResult {
	readonly stdoutFile: string;
	readonly stderrFile: string;
	readonly leftAtExit: readonly number[] | null;
}
function signalGroup(group: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-group, signal);
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
	}
}
async function groupMembers(group: number): Promise<readonly number[]> {
	const child = spawn('ps', ['-axo', 'pid=,pgid=,stat='], { stdio: ['ignore', 'pipe', 'pipe'] });
	const chunks: Buffer[] = [];
	child.stdout.on('data', (data: Buffer): void => {
		chunks.push(data);
	});
	const ending = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	if (ending !== 0) throw new Error('Cannot observe owned process group');
	return Buffer.concat(chunks)
		.toString('utf8')
		.split('\n')
		.flatMap((line) => {
			const [pid, pgid, status] = line.trim().split(/\s+/u);
			return Number(pgid) === group && status !== undefined && !status.startsWith('Z')
				? [Number(pid)]
				: [];
		});
}
async function observeReap(group: number, attempts: number): Promise<readonly number[]> {
	const members = await groupMembers(group);
	if (members.length === 0 || attempts === 0) return members;
	// Each awaited ps completion is an OS event, not a timer or sleep.
	return observeReap(group, attempts - 1);
}

/** Await parent exit, not pipe close: a surviving descendant cannot hold our cleanup hostage. */
export async function runCommand(props: {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly logPrefix: string;
	readonly observeGroup?: (group: number) => Promise<readonly number[]>;
	readonly openLog?: (file: string) => Promise<FileHandle>;
}): Promise<CommandResult> {
	const stdoutFile = `${props.logPrefix}.stdout.log`;
	const stderrFile = `${props.logPrefix}.stderr.log`;
	const openLog = props.openLog ?? ((file: string): Promise<FileHandle> => open(file, 'wx', 0o600));
	const stdout = await openLog(stdoutFile);
	try {
		const stderr = await openLog(stderrFile);
		try {
			const child = spawn(props.executable, [...props.args], {
				cwd: props.cwd,
				env: props.env,
				detached: true,
				stdio: ['ignore', stdout.fd, stderr.fd],
			});
			const group = child.pid;
			const cancel = (): void => {
				if (group !== undefined) signalGroup(group, 'SIGKILL');
			};
			process.once('SIGINT', cancel);
			process.once('SIGTERM', cancel);
			try {
				const ending = await new Promise<{
					readonly code: number | null;
					readonly signal: NodeJS.Signals | null;
				}>((resolve, reject) => {
					child.once('error', reject);
					child.once('exit', (code, signal): void => resolve({ code, signal }));
				});
				const leftAtExit =
					group === undefined ? [] : await (props.observeGroup ?? groupMembers)(group);
				if (group !== undefined && leftAtExit.length > 0) signalGroup(group, 'SIGKILL');
				const remaining = group === undefined ? [] : await observeReap(group, 20);
				return { ...ending, remaining, leftAtExit, stdoutFile, stderrFile };
			} catch {
				cancel();
				return {
					code: null,
					signal: null,
					remaining: null,
					leftAtExit: null,
					stdoutFile,
					stderrFile,
				};
			} finally {
				process.off('SIGINT', cancel);
				process.off('SIGTERM', cancel);
			}
		} finally {
			await stderr.close();
		}
	} finally {
		await stdout.close();
	}
}

export async function commandText(props: {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly logPrefix: string;
}): Promise<string> {
	const result = await runCommand(props);
	if (
		result.code !== 0 ||
		result.signal !== null ||
		result.remaining === null ||
		result.remaining.length > 0 ||
		result.leftAtExit === null ||
		result.leftAtExit.length > 0
	)
		throw new Error('Required command did not finish cleanly');
	return (await readFile(result.stdoutFile, 'utf8')).trim();
}
