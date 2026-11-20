import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { securityChecks } from '../../verification/security-checks';
import { signInVerificationBaseline } from '../../verification/target-baseline';
import { commandText } from './verification-command';
import { reportPassed, renderReport } from './verification-decisions';
import { flows, flowIds, type FlowId } from './verification-flows';
import { runVerification } from './verification-runner';

type Journey = FlowId | 'security-checks' | 'all';
function listOption(value: string | undefined, defaults: readonly string[]): readonly string[] {
	if (value === undefined) return defaults;
	if (value === 'none') return [];
	const entries = value.split(',');
	if (entries.some((entry) => entry.length === 0) || new Set(entries).size !== entries.length)
		throw new Error('Use unique comma-separated names');
	return entries;
}
function requireFlows(values: readonly string[]): readonly FlowId[] {
	return values.map((value) => {
		const id = flowIds.find((candidate) => candidate === value);
		if (id === undefined) throw new Error('Unknown journey');
		return id;
	});
}
export function resolveVerificationSelection(props: {
	readonly journey: Journey;
	readonly flows: string | undefined;
	readonly checks: string | undefined;
}): { readonly flows: readonly FlowId[]; readonly checks: readonly string[] } {
	const selectedFlows = requireFlows(
		listOption(
			props.flows,
			props.journey === 'all'
				? flowIds
				: props.journey === 'security-checks'
					? []
					: [props.journey],
		),
	);
	const selectedChecks = listOption(
		props.checks,
		props.journey === 'security-checks' ? securityChecks.map((check) => check.id) : [],
	);
	if (selectedChecks.some((id) => !securityChecks.some((check) => check.id === id)))
		throw new Error('Unknown security check');
	return { flows: selectedFlows, checks: selectedChecks };
}
/** Self-describing journey entry; the target is a fresh checkout, never the invoking worktree. */
export async function verificationMain(journey: Journey, argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			commit: { type: 'string' },
			flows: { type: 'string' },
			checks: { type: 'string' },
			help: { type: 'boolean' },
		},
	});
	const outcome =
		journey === 'security-checks'
			? 'Each selected control fails only at its single named assertion, restores exact source bytes, and then passes on both hosts with cleanup observed.'
			: journey === 'all'
				? flows.map((flow) => flow.behavior).join(' ')
				: flows.find((flow) => flow.id === journey)?.behavior;
	const help = `Verify Switchboard sign-in: ${journey}.
Success: ${outcome}
Usage: pnpm exec tsx scripts/verify-auth/${journey === 'all' ? 'verify-auth' : journey}.ts --commit <commit> [--flows <comma-separated>] [--checks <comma-separated>]

Makes a fresh temporary checkout, installs the frozen lockfile, builds, and runs the selected permanent tests on cloudflare and node.
Passkey, organizations and CLI include delivered real Chrome journeys; agents use CLI/HTTP/Gateway; HTTP and pure assertions remain labelled as such.
Security checks apply exact qualified edits, require the named assertion red, restore the entire source, rebuild and require green on both hosts.
Prints commit, actual test names/counts, result/assertion, exact restore and remaining processes with run paths in their argument lists. JSON report survives cleanup. Raw logs are kept privately only on failure.
Never uses Keychain, never edits the invoking checkout, never pushes, and introduces no timers or sleeps.

Use a commit containing the current test inventory. Public main ${signInVerificationBaseline} is the shared capability baseline.
The aggregate defaults to all four journeys. Use the security-checks entry for sensitivity checks.
B2 routes: pnpm verify:sign-in organization|revision-fence --target-file <file>.
Machine login is future coverage, not a passing skipped journey.
Browser journeys install the target lockfile’s Chromium bundle through Playwright. Agents require no browser.
Each entry accepts --flows/--checks overrides; 'none' selects no entries of that kind. Missing tests, unknown selection, setup failure, unrelated red or unfinished cleanup exits nonzero.
No every-receipt ready or artifact-inventory admission. Permanent tests own their real readiness and semantic assertions.
`;
	if (values.help) {
		process.stdout.write(help);
		return 0;
	}
	if (positionals.length > 0 || values.commit === undefined) {
		process.stderr.write(help);
		return 1;
	}
	const driverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
	const prep = await mkdtemp(path.join(tmpdir(), 'verify-resolve-'));
	try {
		const commit = await commandText({
			executable: 'git',
			args: ['rev-parse', '--verify', `${values.commit}^{commit}`],
			cwd: driverRoot,
			env: process.env,
			logPrefix: path.join(prep, 'commit'),
		});
		const selected = resolveVerificationSelection({
			journey,
			flows: values.flows,
			checks: values.checks,
		});
		const result = await runVerification({
			driverRoot,
			commit,
			flows: selected.flows,
			checks: selected.checks,
		});
		process.stdout.write(
			`${renderReport(result.rows)}\nReport: ${path.join(result.evidence, 'report.json')}\n`,
		);
		return result.problems.length === 0 && reportPassed(result.rows) ? 0 : 1;
	} catch {
		// No exception/command body is printed: a provider diagnostic can contain credentials.
		process.stderr.write(
			'Verification could not start. Check commit, selection and prerequisites.\n',
		);
		return 1;
	} finally {
		// Resolver logs contain only Git commit resolution, never an app instance or credential.
		await readFile(path.join(prep, 'commit.stdout.log')).catch(() => undefined);
		await rm(prep, { recursive: true });
	}
}
