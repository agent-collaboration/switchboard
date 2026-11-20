import { execFile, spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

interface VerificationCommand {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly logPrefix: string;
}

export interface CommandResult {
	readonly stdoutFile: string;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

/** Each command closes its own resources. The runner awaits its direct child's close. */
export async function runCommand(command: VerificationCommand): Promise<CommandResult> {
	const stdoutFile = `${command.logPrefix}.stdout.log`;
	const stdout = await open(stdoutFile, 'wx', 0o600);
	try {
		const stderr = await open(`${command.logPrefix}.stderr.log`, 'wx', 0o600);
		try {
			const child = spawn(command.executable, [...command.args], {
				cwd: command.cwd,
				env: command.env,
				stdio: ['ignore', stdout.fd, stderr.fd],
			});
			return await new Promise<CommandResult>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', (code, signal): void => resolve({ stdoutFile, code, signal }));
			});
		} finally {
			await stderr.close();
		}
	} finally {
		await stdout.close();
	}
}

export async function commandText(command: VerificationCommand): Promise<string> {
	const result = await runCommand(command);
	if (result.code !== 0 || result.signal !== null)
		throw new Error('Required verification command failed');
	return (await readFile(result.stdoutFile, 'utf8')).trim();
}

/** One snapshot of command lines containing these private run paths. No processes are signalled. */
export async function matchingRunProcesses(roots: readonly string[]): Promise<readonly number[]> {
	const { stdout } = await promisify(execFile)('ps', ['-ww', '-axo', 'pid=,command='], {
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout.split('\n').flatMap((line) => {
		const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
		if (match?.[1] === undefined || match[2] === undefined) return [];
		const command = match[2];
		return roots.some((root) => command.includes(root + path.sep)) ? [Number(match[1])] : [];
	});
}
