import { constants } from 'node:fs';
import {
	readFile,
	writeFile,
	mkdtemp,
	mkdir,
	rm,
	access,
	realpath,
	lstat,
	open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
	securityChecks,
	securityAssertions,
	type SecurityCheck,
	type SecurityEdit,
} from '../../verification/security-checks';
import { resolveAssertionLocation } from './verification-assertion-anchor';
import {
	reportPassed,
	testReportSchema,
	observedAssertions,
	decideTestRun,
	replaceExact,
	decideRestoration,
	type DecidingFacts,
	type TestSelection,
	type ExpectedFailure,
} from './verification-decisions';
import { flows, type FlowId } from './verification-flows';
import { commandText, runCommand, type CommandResult } from './verification-process';
import {
	transitionSecurityPhase,
	securityPhaseEffect,
	type SecurityPhase,
	type SecurityEvent,
} from './verification-security-phase';

export interface VerificationOptions {
	readonly commit: string;
	readonly flows: readonly FlowId[];
	readonly checks: readonly string[];
	readonly driverRoot: string;
}
export interface VerificationReport {
	readonly commit: string;
	readonly chrome: string;
	readonly requested: { readonly flows: readonly string[]; readonly checks: readonly string[] };
	readonly rows: readonly DecidingFacts[];
	readonly problems: readonly string[];
	readonly evidence: string;
}
interface Context {
	readonly options: VerificationOptions;
	readonly evidence: string;
	readonly logs: string;
	readonly env: NodeJS.ProcessEnv;
	sequence: number;
	active: { id: string; host: DecidingFacts['host'] };
	cleanupUnknown: boolean;
}
function safeFile(root: string, relative: string): string {
	if (
		path.isAbsolute(relative) ||
		relative.split(/[\\/]/u).includes('..') ||
		/keychain/iu.test(relative)
	)
		throw new Error('Unsafe verification source path');
	return path.join(root, relative);
}
function nextLog(context: Context, label: string): string {
	context.sequence += 1;
	return path.join(context.logs, `${context.sequence}-${label}`);
}
async function text(
	context: Context,
	cwd: string,
	executable: string,
	args: readonly string[],
	label: string,
): Promise<string> {
	context.active = { id: label, host: 'unknown' };
	return commandText({
		executable,
		args,
		cwd,
		env: context.env,
		logPrefix: nextLog(context, label),
	});
}
async function build(context: Context, root: string): Promise<void> {
	await text(context, root, 'pnpm', ['build'], 'build');
}
async function checkout(context: Context, label: string): Promise<string> {
	const parent = await mkdtemp(path.join(tmpdir(), `sign-in-${label}-`));
	const root = path.join(parent, 'source');
	await text(
		context,
		context.options.driverRoot,
		'git',
		['clone', '--shared', '--no-checkout', '--', context.options.driverRoot, root],
		'checkout',
	);
	await text(
		context,
		root,
		'git',
		['checkout', '--detach', context.options.commit],
		'checkout-commit',
	);
	await text(
		context,
		root,
		'git',
		['config', 'remote.origin.pushurl', 'disabled://verification'],
		'disable-push',
	);
	const commit = await text(context, root, 'git', ['rev-parse', 'HEAD'], 'actual-commit');
	if (commit !== context.options.commit) throw new Error('Wrong target commit');
	await text(context, root, 'pnpm', ['install', '--frozen-lockfile'], 'install');
	return realpath(root);
}
async function requireCommit(context: Context, root: string, minimum: string): Promise<void> {
	await text(
		context,
		root,
		'git',
		['merge-base', '--is-ancestor', minimum, 'HEAD'],
		'required-capability',
	);
}
function exactPattern(names: readonly string[]): string {
	return names.map((name) => `^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`).join('|');
}
export function selectSecurityTests(check: SecurityCheck): TestSelection {
	return {
		files: check.testFiles,
		pattern: exactPattern(check.testNames),
		minimumPassed: check.testNames.length,
		requiredNames: check.testNames,
	};
}

interface TestObservation {
	readonly row: DecidingFacts;
	readonly process: CommandResult;
}
async function test(
	context: Context,
	props: {
		readonly root: string;
		readonly host: 'cloudflare' | 'node';
		readonly id: string;
		readonly selection: TestSelection;
		readonly project?: 'unit' | 'e2e-host';
		readonly expected?: ExpectedFailure;
	},
): Promise<TestObservation> {
	context.active = { id: props.id, host: props.host };
	for (const file of props.selection.files) await access(safeFile(props.root, file));
	const prefix = nextLog(context, `${props.id}-${props.host}`);
	const reportFile = `${prefix}.vitest.json`;
	const runtimeErrorsFile = `${prefix}.runtime-errors.json`;
	const env: NodeJS.ProcessEnv = {
		...context.env,
		SIGN_IN_TEST_HOST: props.host,
		SIGN_IN_VERIFICATION_ERRORS_FILE: runtimeErrorsFile,
	};
	// Ordinary permanent tests own their harness and assertions. No per-receipt wrapper admission.
	delete env.AUTH_PROOF_MANIFEST_FILE;
	delete env.AUTH_PROOF_NODE_MANIFEST_FILE;
	delete env.AUTH_TEST_TARGET;
	const result = await runCommand({
		executable: 'pnpm',
		cwd: props.root,
		env,
		logPrefix: prefix,
		args: [
			'exec',
			'vitest',
			'run',
			'--config',
			'vitest.config.ts',
			'--project',
			props.project ?? 'e2e-host',
			...props.selection.files,
			...(props.selection.pattern === undefined ? [] : ['-t', props.selection.pattern]),
			'--reporter=json',
			`--reporter=${fileURLToPath(new URL('./verification-runtime-errors.ts', import.meta.url))}`,
			`--outputFile=${reportFile}`,
		],
	});
	const report = testReportSchema.parse(JSON.parse(await readFile(reportFile, 'utf8')));
	const runtimeErrors = z
		.number()
		.int()
		.nonnegative()
		.parse(JSON.parse(await readFile(runtimeErrorsFile, 'utf8')));
	const left = result.remaining;
	if (left === null) context.cleanupUnknown = true;
	let verdict = decideTestRun({
		checkoutRoot: props.root,
		report,
		selection: props.selection,
		process: { ...result, remaining: left },
		runtimeErrors,
		...(props.expected === undefined ? {} : { expected: props.expected }),
	});
	if (result.cleanup.kind !== 'natural' && verdict.kind === 'passed')
		verdict = {
			kind: 'failed',
			reason: 'owned descendants required SIGTERM after bounded natural reaping',
			assertion: null,
		};
	return {
		process: result,
		row: {
			id: props.id,
			host: props.host,
			commit: context.options.commit,
			tests: {
				passed: report.numPassedTests,
				failed: report.numFailedTests,
				skipped: report.numPendingTests,
				names: observedAssertions(report)
					.filter((assertion) => assertion.status === 'passed' || assertion.status === 'failed')
					.map((assertion) => assertion.name),
			},
			verdict,
			restored: null,
			remaining: left,
			leftAtExit: result.leftAtExit,
			cleanup: result.cleanup.kind,
		},
	};
}
async function sourceMap(
	context: Context,
	root: string,
): Promise<Readonly<Record<string, string>>> {
	const diff = await text(context, root, 'git', ['diff', '--binary', 'HEAD'], 'source-restore');
	const untracked = await text(
		context,
		root,
		'git',
		['ls-files', '--others', '--exclude-standard'],
		'source-extras',
	);
	// A fresh target starts clean. Exact empty diff and no untracked source decide whole-source restore.
	return { diff, untracked };
}
export interface OriginalSource {
	readonly resolvedPath: string;
	readonly bytes: Buffer;
}
async function resolvedSourceFile(root: string, relative: string): Promise<string> {
	const canonicalRoot = await realpath(root);
	const destination = safeFile(canonicalRoot, relative);
	const inside = path.relative(canonicalRoot, destination);
	if (
		inside.length === 0 ||
		inside === '..' ||
		inside.startsWith(`..${path.sep}`) ||
		path.isAbsolute(inside)
	)
		throw new Error('Source destination must stay inside the checkout');
	let walked = canonicalRoot;
	for (const component of inside.split(path.sep)) {
		walked = path.join(walked, component);
		if ((await lstat(walked)).isSymbolicLink())
			throw new Error('Source destination must not contain symlinks');
	}
	const resolved = await realpath(destination);
	if (resolved !== destination || !(await lstat(resolved)).isFile())
		throw new Error('Source destination must be a regular checkout file');
	return resolved;
}
export async function applySecurityEdits(
	root: string,
	edits: readonly SecurityEdit[],
	originals: Map<string, OriginalSource>,
): Promise<void> {
	for (const edit of edits) {
		const resolvedPath = await resolvedSourceFile(root, edit.file);
		const handle = await open(resolvedPath, constants.O_RDWR | constants.O_NOFOLLOW);
		try {
			const bytes = await handle.readFile();
			const prior = originals.get(edit.file);
			if (prior !== undefined && prior.resolvedPath !== resolvedPath)
				throw new Error('Source destination changed');
			// Acquire exact byte custody before any write, including partial multi-file mutations.
			if (prior === undefined) originals.set(edit.file, { resolvedPath, bytes });
			const mutation = Buffer.from(replaceExact(bytes.toString('utf8'), edit.find, edit.replace));
			if ((await handle.write(mutation, 0, mutation.length, 0)).bytesWritten !== mutation.length)
				throw new Error('Incomplete mutation write');
			await handle.truncate(mutation.length);
		} finally {
			await handle.close();
		}
	}
}

export async function restoreSecurityEdits(
	root: string,
	originals: ReadonlyMap<string, OriginalSource>,
): Promise<void> {
	const attempts = await Promise.allSettled(
		[...originals].map(async ([relative, original]): Promise<void> => {
			const destination = await resolvedSourceFile(root, relative);
			if (destination !== original.resolvedPath)
				throw new Error('Original source destination changed');
			const handle = await open(destination, constants.O_RDWR | constants.O_NOFOLLOW);
			try {
				if (
					(await handle.write(original.bytes, 0, original.bytes.length, 0)).bytesWritten !==
					original.bytes.length
				)
					throw new Error('Incomplete restoration write');
				await handle.truncate(original.bytes.length);
			} finally {
				await handle.close();
			}
			if (!(await readFile(await resolvedSourceFile(root, relative))).equals(original.bytes))
				throw new Error('Restored source bytes disagree');
		}),
	);
	if (attempts.some((attempt) => attempt.status === 'rejected'))
		throw new Error('Original source bytes could not all be restored');
}

function problemRow(
	context: Context,
	id: string,
	host: DecidingFacts['host'],
	reason: string,
): DecidingFacts {
	return {
		id,
		host,
		commit: context.options.commit,
		tests: { passed: 0, failed: 0, skipped: 0, names: [] },
		verdict: { kind: 'failed', reason, assertion: null },
		restored: null,
		remaining: null,
		leftAtExit: null,
		cleanup: 'unknown',
	};
}
async function security(context: Context, check: SecurityCheck): Promise<readonly DecidingFacts[]> {
	const root = await checkout(context, check.id);
	const before = await sourceMap(context, root);
	await requireCommit(context, root, check.minimumCommit);
	const site = securityAssertions[check.id];
	if (site === undefined) throw new Error('Security check has no adopted assertion site');
	const testSource = await readFile(safeFile(root, site.file), 'utf8');
	const location = resolveAssertionLocation({ ...site, source: testSource });
	const selection = selectSecurityTests(check);
	const originals = new Map<string, OriginalSource>();
	const rows: DecidingFacts[] = [];
	let phase: SecurityPhase = {
		kind: 'prepared',
		expectedAssertion: `${location.file}:${location.line}`,
	};
	while (true) {
		const effect = securityPhaseEffect(phase);
		if (effect.kind === 'done') {
			if (!context.cleanupUnknown) await rm(path.dirname(root), { recursive: true });
			return rows.map((row) => ({ ...row, restored: true }));
		}
		if (effect.kind === 'stop') {
			if (!rows.some((row) => row.verdict.kind === 'failed'))
				rows.push(problemRow(context, `${check.id}-phase`, 'unknown', effect.reason));
			return rows.map((row) => ({ ...row, restored: effect.restored }));
		}
		let event: SecurityEvent;
		try {
			switch (effect.kind) {
				case 'mutate-and-build':
					await applySecurityEdits(root, check.edits, originals);
					await build(context, root);
					event = { kind: 'mutant-built' };
					break;
				case 'run-red': {
					const observation = await test(context, {
						root,
						host: effect.host,
						id: `${check.id}-red`,
						selection,
						project: check.project,
						expected: { failure: check.expectedFailure, count: check.expectedFailures, location },
					});
					rows.push(observation.row);
					event = { kind: 'red-observed', host: effect.host, verdict: observation.row.verdict };
					break;
				}
				case 'restore':
					await restoreSecurityEdits(root, originals);
					event = {
						kind: 'source-restored',
						exact: decideRestoration(before, await sourceMap(context, root)),
					};
					break;
				case 'rebuild':
					await build(context, root);
					event = { kind: 'restored-built' };
					break;
				case 'run-green': {
					const observation = await test(context, {
						root,
						host: effect.host,
						id: `${check.id}-green`,
						selection,
						project: check.project,
					});
					rows.push(observation.row);
					event = { kind: 'green-observed', host: effect.host, verdict: observation.row.verdict };
					break;
				}
				default:
					effect satisfies never;
					throw new Error('Unknown security effect');
			}
		} catch {
			event = { kind: 'execution-failed', reason: 'security effect did not complete' };
		}
		phase = transitionSecurityPhase(phase, event);
	}
}

export async function runVerification(options: VerificationOptions): Promise<VerificationReport> {
	const evidence = await mkdtemp(path.join(tmpdir(), 'verify-sign-in-'));
	const logs = path.join(evidence, 'logs');
	const temporary = path.join(evidence, 't');
	await mkdir(logs, { mode: 0o700 });
	await mkdir(temporary, { mode: 0o700 });
	const context: Context = {
		options,
		evidence,
		logs,
		env: { ...process.env, TMPDIR: temporary },
		sequence: 0,
		active: { id: 'setup', host: 'unknown' },
		cleanupUnknown: false,
	};
	const rows: DecidingFacts[] = [];
	const problems: string[] = [];
	let chrome = 'unavailable';
	try {
		chrome = await text(
			context,
			options.driverRoot,
			process.env.CHROME_BIN ?? 'google-chrome',
			['--version'],
			'chrome-version',
		);
		if (!/^[a-f0-9]{40}$/u.test(options.commit)) throw new Error('A full commit is required');
		if (options.flows.length + options.checks.length === 0) throw new Error('Nothing selected');
		if (options.flows.length > 0) {
			const root = await checkout(context, 'flows');
			let completed = false;
			try {
				await build(context, root);
				for (const id of options.flows) {
					const flow = flows.find((candidate) => candidate.id === id);
					if (flow === undefined) throw new Error('Unknown flow');
					await requireCommit(context, root, flow.minimumCommit);
					for (const host of ['cloudflare', 'node'] as const) {
						for (const [index, selection] of flow.selections(host).entries()) {
							const observation = await test(context, {
								root,
								host,
								id: `${id}-${index + 1}`,
								selection,
							});
							rows.push(observation.row);
							if (observation.row.verdict.kind === 'failed')
								throw new Error('Journey failed its adopted outcome');
						}
					}
				}
				completed = true;
			} finally {
				if (completed && !context.cleanupUnknown) await rm(path.dirname(root), { recursive: true });
			}
		}
		for (const id of options.checks) {
			const check = securityChecks.find((candidate) => candidate.id === id);
			if (check === undefined) throw new Error('Unknown security check');
			const result = await security(context, check);
			rows.push(...result);
			if (result.some((row) => row.verdict.kind === 'failed'))
				throw new Error('Security check failed');
		}
	} catch {
		// Never echo provider, command stderr, JSON bodies or exception messages into the safe report.
		problems.push(
			'Verification stopped: inspect the private failure logs; no later outcome is credited.',
		);
		if (!rows.some((row) => row.verdict.kind === 'failed'))
			rows.push(
				problemRow(
					context,
					context.active.id,
					context.active.host,
					'required setup or execution did not complete',
				),
			);
	}
	const result: VerificationReport = {
		commit: options.commit,
		chrome,
		requested: { flows: options.flows, checks: options.checks },
		rows,
		problems,
		evidence,
	};
	await writeFile(path.join(evidence, 'report.json'), JSON.stringify(result, null, 2) + '\n', {
		mode: 0o600,
	});
	await cleanupSuccessfulEvidence(result);
	return result;
}

export async function cleanupSuccessfulEvidence(report: VerificationReport): Promise<void> {
	if (report.problems.length === 0 && reportPassed(report.rows)) {
		await rm(path.join(report.evidence, 'logs'), { recursive: true });
		await rm(path.join(report.evidence, 't'), { recursive: true });
	}
}
