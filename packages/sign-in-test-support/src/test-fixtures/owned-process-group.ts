import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

const identitySchema = z.object({
	pid: z.number().int().positive(),
	parent: z.number().int().nonnegative(),
	group: z.number().int().positive(),
	command: z.string().min(1),
	state: z.string().min(1),
});
export type OwnedProcessIdentity = z.infer<typeof identitySchema>;
export type GroupSignalAttempt = {
	readonly kind: 'sent' | 'already-gone' | 'failed';
	readonly signal: 'SIGTERM';
};
export type GroupTermination = { readonly kind: 'not-requested' } | GroupSignalAttempt;
interface GroupObservations {
	readonly group: number;
	readonly reads: readonly (readonly OwnedProcessIdentity[])[];
}
export type OwnedGroupCleanup =
	| (GroupObservations & {
			readonly kind: 'natural';
			readonly remaining: readonly [];
			readonly termination: { readonly kind: 'not-requested' };
	  })
	| (GroupObservations & {
			readonly kind: 'intervened';
			readonly termination: GroupSignalAttempt;
			readonly remaining: readonly OwnedProcessIdentity[];
	  })
	| (GroupObservations & {
			readonly kind: 'unknown';
			readonly remaining: null;
			readonly termination: GroupTermination;
	  });

export async function readOwnedProcessGroup(
	group: number,
): Promise<readonly OwnedProcessIdentity[]> {
	if (!Number.isSafeInteger(group) || group <= 0) throw new Error('Invalid owned process group');
	const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], {
		maxBuffer: 4 * 1024 * 1024,
	});
	return stdout.split('\n').flatMap((line) => {
		const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
		if (row?.[3] === undefined || Number(row[3]) !== group) return [];
		return [
			identitySchema.parse({
				pid: Number(row[1]),
				parent: Number(row[2]),
				group: Number(row[3]),
				state: row[4],
				command: path.basename(row[5] ?? ''),
			}),
		];
	});
}

export function activeOwnedProcessMembers(
	members: readonly OwnedProcessIdentity[],
): readonly OwnedProcessIdentity[] {
	return members.filter((member) => !member.state.startsWith('Z'));
}

export function terminateOwnedProcessGroup(group: number): GroupSignalAttempt {
	if (!Number.isSafeInteger(group) || group <= 0) return { kind: 'failed', signal: 'SIGTERM' };
	try {
		process.kill(-group, 'SIGTERM');
		return { kind: 'sent', signal: 'SIGTERM' };
	} catch (error) {
		return {
			kind:
				error instanceof Error && 'code' in error && error.code === 'ESRCH'
					? 'already-gone'
					: 'failed',
			signal: 'SIGTERM',
		};
	}
}

/** Five completed OS reads per phase; intervention never becomes a natural completion. */
export async function settleOwnedProcessGroup(props: {
	readonly group: number;
	readonly read?: (group: number) => Promise<readonly OwnedProcessIdentity[]>;
	readonly terminate?: (group: number) => GroupSignalAttempt;
	readonly initialTermination?: GroupSignalAttempt;
}): Promise<OwnedGroupCleanup> {
	const read = props.read ?? readOwnedProcessGroup;
	const reads: (readonly OwnedProcessIdentity[])[] = [];
	let termination: GroupTermination = props.initialTermination ?? { kind: 'not-requested' };
	const terminate = (): void => {
		if (termination.kind !== 'not-requested') return;
		// Mark the single attempt before calling the effect, even if an injected effect throws.
		termination = { kind: 'failed', signal: 'SIGTERM' };
		try {
			termination = (props.terminate ?? terminateOwnedProcessGroup)(props.group);
		} catch {
			/* Outcome remains failed. */
		}
	};
	async function readUntilEmpty(attempts: number): Promise<readonly OwnedProcessIdentity[]> {
		const observed = await read(props.group);
		reads.push(observed);
		const active = activeOwnedProcessMembers(observed);
		if (active.length === 0 || attempts === 1) return active;
		return readUntilEmpty(attempts - 1);
	}
	try {
		if (termination.kind === 'not-requested') {
			const remaining = await readUntilEmpty(5);
			if (remaining.length === 0)
				return { kind: 'natural', group: props.group, reads, termination, remaining: [] };
			terminate();
		}
		const remaining = await readUntilEmpty(5);
		if (termination.kind === 'not-requested')
			return { kind: 'unknown', group: props.group, reads, termination, remaining: null };
		return { kind: 'intervened', group: props.group, reads, termination, remaining };
	} catch {
		terminate();
		return { kind: 'unknown', group: props.group, reads, termination, remaining: null };
	}
}
