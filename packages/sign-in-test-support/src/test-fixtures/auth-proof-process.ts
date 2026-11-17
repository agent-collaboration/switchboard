import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export type ProofProcessEnding =
	| {
			readonly kind: 'exited';
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
	  }
	| {
			readonly kind: 'timed-out';
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
	  }
	| {
			readonly kind: 'output-limit';
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
	  }
	| {
			readonly kind: 'cancelled';
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
	  }
	| { readonly kind: 'spawn-failed'; readonly message: string };

/** Test the owned process group without spawning a host command. */
function proofProcessGroupExists(groupId: number): boolean {
	try {
		process.kill(-groupId, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error) {
			if (error.code === 'ESRCH') return false;
			if (error.code === 'EPERM') return true;
		}
		throw error;
	}
}

/** List members only when the owned group exists; a failed listing never proves emptiness. */
export async function liveProofProcessGroup(groupId: number): Promise<readonly number[]> {
	if (!proofProcessGroupExists(groupId)) return [];
	let stdout: string;
	try {
		({ stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,pgid='], {
			maxBuffer: 4 * 1024 * 1024,
		}));
	} catch (error) {
		if (!proofProcessGroupExists(groupId)) return [];
		throw error;
	}
	const members = stdout.split('\n').flatMap((line) => {
		const [pidText, groupText] = line.trim().split(/\s+/u);
		const pid = Number(pidText);
		return Number(groupText) === groupId && Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
	});
	if (members.length === 0 && proofProcessGroupExists(groupId))
		throw new Error('Owned process group exists but its members could not be listed');
	return members;
}

function signalProofGroup(groupId: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-groupId, signal);
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
	}
}

async function waitForProofGroupReap(
	groupId: number | undefined,
	remainingAttempts: number,
): Promise<readonly number[]> {
	if (groupId === undefined || !proofProcessGroupExists(groupId)) return [];
	if (remainingAttempts === 0) return liveProofProcessGroup(groupId);
	// Each ps completion is an OS observation event; never delay on wall time.
	if ((await liveProofProcessGroup(groupId)).length === 0) return [];
	return waitForProofGroupReap(groupId, remainingAttempts - 1);
}

export async function runAuthProofProcess(props: {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly deadline?: AbortSignal;
	readonly onStarted?: (processGroup: number) => void;
}): Promise<{
	readonly ending: ProofProcessEnding;
	readonly processGroup: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly cleanup: {
		readonly initialMembers: readonly number[];
		readonly remainingMembers: readonly number[];
		readonly signals: readonly NodeJS.Signals[];
	};
}> {
	if (process.platform === 'win32') throw new Error('Proof process groups require a POSIX target');
	const child = spawn(props.command, [...props.args], {
		cwd: props.cwd,
		env: props.env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
	});
	const groupId = child.pid;
	const signals: NodeJS.Signals[] = [];
	let stopReason: 'timed-out' | 'output-limit' | 'cancelled' | undefined;
	function signalGroup(signal: NodeJS.Signals): void {
		if (groupId === undefined) return;
		signals.push(signal);
		signalProofGroup(groupId, signal);
	}
	function stopGroup(reason: 'timed-out' | 'output-limit' | 'cancelled'): void {
		if (stopReason !== undefined) return;
		stopReason = reason;
		signalGroup('SIGTERM');
		signalGroup('SIGKILL');
	}
	const cancel = (): void => stopGroup('cancelled');
	process.once('SIGTERM', cancel);
	process.once('SIGINT', cancel);
	const deadline = (): void => stopGroup('timed-out');
	props.deadline?.addEventListener('abort', deadline, { once: true });
	if (props.deadline?.aborted === true) deadline();
	let outputBytes = 0;
	async function collect(stream: NodeJS.ReadableStream): Promise<string> {
		let output = '';
		for await (const chunk of stream) {
			const text = String(chunk);
			outputBytes += Buffer.byteLength(text);
			if (outputBytes > 8 * 1024 * 1024) stopGroup('output-limit');
			else output += text;
		}
		return output;
	}
	const output = Promise.all([collect(child.stdout), collect(child.stderr)]);
	void output.catch(() => undefined);
	try {
		// A proof can retain ownership even when it deliberately breaks the runner's completion.
		if (groupId !== undefined) props.onStarted?.(groupId);
		const exit = await new Promise<ProofProcessEnding>((resolve) => {
			child.once('error', (error) => resolve({ kind: 'spawn-failed', message: error.message }));
			child.once('close', (code, signal) =>
				resolve({ kind: stopReason ?? 'exited', code, signal }),
			);
		});
		const initialMembers = groupId === undefined ? [] : await liveProofProcessGroup(groupId);
		if (initialMembers.length > 0) {
			if (stopReason === undefined) signalGroup('SIGTERM');

			signalGroup('SIGKILL');
		}
		const remainingMembers = await waitForProofGroupReap(groupId, 20);
		const [stdout, stderr] = await output;
		return {
			ending: exit,
			processGroup: groupId ?? null,
			stdout,
			stderr,
			cleanup: { initialMembers, remainingMembers, signals },
		};
	} catch (error) {
		// A failed observer must not strand a process group either.
		signalGroup('SIGTERM');
		signalGroup('SIGKILL');
		throw error;
	} finally {
		props.deadline?.removeEventListener('abort', deadline);
		process.off('SIGTERM', cancel);
		process.off('SIGINT', cancel);
	}
}
