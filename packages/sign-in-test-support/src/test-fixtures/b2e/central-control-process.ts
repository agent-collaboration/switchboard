import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { afterAll } from 'vitest';
import { z } from 'zod';

/**
 * The one protocol both of central's B2e processes speak (codex-router PR #270): the native
 * `central_sign_in_launcher` and the workerd `tests/support/workerd-bridge.mts`. One JSON
 * readiness line on stdout; one JSON answer on stderr per stdin command (`{setTimeMs}` and
 * `{observe}`), in order. Other stderr lines are diagnostics, kept for the receipt and never
 * parsed for credentials.
 */
const answerSchema = z.looseObject({ answer: z.string() });
export type CentralAnswer = z.infer<typeof answerSchema>;

export interface CentralControlProcess<TReadiness> {
	readonly readiness: TReadiness;
	/** Central's one clock for every organization, live or opened later. */
	readonly setTime: (milliseconds: number) => Promise<CentralAnswer>;
	/** Central's read-only, one-snapshot observation of one organization's sign-in rows. */
	readonly observe: (organization: string) => Promise<CentralAnswer>;
	readonly diagnostics: readonly string[];
	readonly pid: number;
	/** The process's exit code once it has exited (null when a signal ended it). */
	readonly exited: Promise<number | null>;
	/** The process's own clean shutdown, then its exit code. */
	readonly close: () => Promise<number | null>;
}

/**
 * Every central process this fixture started that has not exited yet. `close()` is the normal
 * path. A case whose `finally` never runs (its body still awaiting when Vitest times it out)
 * leaves its process here, and the teardown below ends exactly those children.
 */
const processesStillRunning = new Map<
	number,
	{
		readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
		readonly exited: Promise<number | null>;
	}
>();

/**
 * Sends SIGTERM to each central process this fixture spawned that is still running, by its own
 * child handle (no pattern or group kill), and returns the process ids it signalled.
 */
export function stopCentralProcessesLeftRunning(): readonly number[] {
	const signalled: number[] = [];
	for (const [pid, { child }] of processesStillRunning)
		if (child.exitCode === null && child.signalCode === null && child.kill('SIGTERM'))
			signalled.push(pid);
	return signalled;
}

/** The same, then waits on each signalled process's own exit event before returning. */
export async function endCentralProcessesLeftRunning(): Promise<readonly number[]> {
	const exits = [...processesStillRunning.values()].map((running) => running.exited);
	const signalled = stopCentralProcessesLeftRunning();
	await Promise.all(exits);
	return signalled;
}

let exitHookRegistered = false;
function registerExitHook(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	// Last resort when the worker exits without its teardown hooks; `kill` is synchronous.
	process.once('exit', () => {
		stopCentralProcessesLeftRunning();
	});
}

/**
 * Call at a suite's top level: its `afterAll` ends any central process a hung case left
 * running and waits for each to exit.
 */
export function useCentralProcessTeardown(): void {
	afterAll(async () => {
		await endCentralProcessesLeftRunning();
	});
}

export async function startCentralControlProcess<TReadiness>(props: {
	readonly executable: string;
	readonly arguments: readonly string[];
	readonly cwd?: string;
	readonly readinessSchema: z.ZodType<TReadiness>;
	/** How this process shuts itself down cleanly: SIGTERM, or a `close` line on stdin. */
	readonly shutdown: 'sigterm' | 'stdin-close';
}): Promise<CentralControlProcess<TReadiness>> {
	const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
		props.executable,
		[...props.arguments],
		{ stdio: ['pipe', 'pipe', 'pipe'], ...(props.cwd === undefined ? {} : { cwd: props.cwd }) },
	);
	const { pid } = child;
	if (pid === undefined) throw new Error(`Central process ${props.executable} did not start`);
	registerExitHook();
	const exited = new Promise<number | null>((resolveExit) => {
		child.once('exit', (code) => {
			processesStillRunning.delete(pid);
			resolveExit(code);
		});
	});
	processesStillRunning.set(pid, { child, exited });
	const diagnostics: string[] = [];
	const pendingAnswers: ((answer: CentralAnswer) => void)[] = [];
	createInterface({ input: child.stderr }).on('line', (line) => {
		diagnostics.push(line);
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		const answer = answerSchema.safeParse(parsed);
		if (answer.success) pendingAnswers.shift()?.(answer.data);
	});
	const readiness = await new Promise<TReadiness>((resolveReady, rejectReady) => {
		const lines = createInterface({ input: child.stdout });
		lines.once('line', (line) => {
			try {
				resolveReady(props.readinessSchema.parse(JSON.parse(line)));
			} catch (error) {
				rejectReady(error);
			}
		});
		void exited.then((code) =>
			rejectReady(new Error(`Central process exited before readiness (${String(code)})`)),
		);
	});
	// After readiness, stdout carries nothing the fixture reads; keep it drained.
	child.stdout.resume();
	async function command(input: Readonly<Record<string, unknown>>): Promise<CentralAnswer> {
		const answered = new Promise<CentralAnswer>((resolveAnswer, rejectAnswer) => {
			pendingAnswers.push(resolveAnswer);
			void exited.then((code) =>
				rejectAnswer(new Error(`Central process exited before answering (${String(code)})`)),
			);
		});
		child.stdin.write(`${JSON.stringify(input)}\n`);
		return answered;
	}
	return {
		readiness,
		diagnostics,
		pid,
		exited,
		setTime: async (milliseconds) => command({ setTimeMs: milliseconds }),
		observe: async (organization) => command({ observe: organization }),
		async close(): Promise<number | null> {
			if (props.shutdown === 'stdin-close') child.stdin.end('close\n');
			else child.kill('SIGTERM');
			return exited;
		},
	};
}
