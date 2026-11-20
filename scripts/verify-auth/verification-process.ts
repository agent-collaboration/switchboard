import { spawn } from 'node:child_process';
import { open, readFile, writeFile, type FileHandle } from 'node:fs/promises';

import {
	activeOwnedProcessMembers,
	settleOwnedProcessGroup,
	terminateOwnedProcessGroup,
	type OwnedProcessIdentity,
	type OwnedGroupCleanup,
	type GroupSignalAttempt,
} from '../../packages/sign-in-test-support/src/test-fixtures/owned-process-group';
import type { ProcessResult } from './verification-decisions';

export interface CommandResult extends ProcessResult {
	readonly stdoutFile: string;
	readonly stderrFile: string;
	readonly leftAtExit: readonly number[] | null;
	readonly cleanup: OwnedGroupCleanup;
}
/** Await parent exit, not pipe close: a surviving descendant cannot hold our cleanup hostage. */
export async function runCommand(props: {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly logPrefix: string;
	readonly observeGroup?: (group: number) => Promise<readonly OwnedProcessIdentity[]>;
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
			let termination: GroupSignalAttempt | undefined;
			const terminateOnce = (): GroupSignalAttempt => {
				termination ??=
					group === undefined
						? { kind: 'failed', signal: 'SIGTERM' }
						: terminateOwnedProcessGroup(group);
				return termination;
			};
			const cancel = (): void => {
				terminateOnce();
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
				if (group === undefined) throw new Error('Missing owned process group');
				let cleanup = await settleOwnedProcessGroup({
					group,
					...(props.observeGroup === undefined ? {} : { read: props.observeGroup }),
					terminate: terminateOnce,
					...(termination === undefined ? {} : { initialTermination: termination }),
				});
				const recordCleanup = (): Promise<void> =>
					writeFile(`${props.logPrefix}.cleanup.json`, JSON.stringify(cleanup, null, 2) + '\n', {
						mode: 0o600,
					});
				await recordCleanup();
				// Cancellation can arrive during the asynchronous evidence write; it cannot become a pass.
				if (cleanup.kind === 'natural' && termination !== undefined) {
					cleanup = { ...cleanup, kind: 'intervened', termination };
					await recordCleanup();
				}

				const leftAtExit =
					cleanup.reads[0] === undefined
						? null
						: activeOwnedProcessMembers(cleanup.reads[0]).map((member) => member.pid);
				const remaining = cleanup.remaining?.map((member) => member.pid) ?? null;
				return { ...ending, remaining, leftAtExit, cleanup, stdoutFile, stderrFile };
			} catch {
				cancel();
				return {
					code: null,
					signal: null,
					remaining: null,
					leftAtExit: null,
					cleanup: {
						kind: 'unknown',
						group: group ?? 0,
						reads: [],
						termination: termination ?? { kind: 'not-requested' },
						remaining: null,
					},
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
		result.cleanup.kind !== 'natural'
	)
		throw new Error('Required command did not finish cleanly');
	return (await readFile(result.stdoutFile, 'utf8')).trim();
}
