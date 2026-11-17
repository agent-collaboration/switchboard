import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { cachedOwnerTokenSchema, type AuthTarget } from '@agent-collaboration/sign-in-owner-cli';
import { z } from 'zod';

import { recordAuthProofPhase } from '#sign-in-test-support/test-fixtures/auth-proof-phase-recording';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	nativeOwnerCliProfileSchema,
	type NativeOwnerCliProfile,
} from '#sign-in-test-support/test-fixtures/native-owner-cli-profile';

const ownerVerificationFailureLines: readonly string[] = [
	'Owner token failed verification (refused:malformed)',
	'Owner token failed verification (refused:wrong-token-type)',
	'Owner token failed verification (refused:bad-signature)',
	'Owner token failed verification (refused:wrong-issuer)',
	'Owner token failed verification (refused:wrong-audience)',
	'Owner token failed verification (refused:not-a-person)',
	'Owner token failed verification (refused:expired)',
	'Owner token failed verification (refused:inactive)',
	'Owner token failed verification (unavailable:keys-unreachable)',
	'Owner token failed verification (unavailable:introspection-unreachable)',
	'Owner token failed verification (wrong-client)',
	'Owner token failed verification (lifetime-exceeds-local-window)',
	'Owner token failed verification (lifetime-exceeds-issuance-ceiling)',
];
const ownerLoginFailureLines: readonly string[] = [
	...ownerVerificationFailureLines,
	'Owner code exchange refused',
	'Owner token failed verification',
	'Owner authorization refused or timed out',
	'Owner loopback listener unavailable',
	'Sign-in service unavailable; no owner authorization started',
	'fetch failed',
];

/** Reuses the actual CLI cache on the next command, so server live-status rejection remains observable. */
export async function runCachedNativeOwnerCommand(props: {
	readonly target: AuthTarget;
	readonly repositoryRoot: string;
	readonly args: readonly string[];
}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
	try {
		const output = await promisify(execFile)(
			process.execPath,
			[
				'--import',
				'./packages/sign-in-test-support/src/test-fixtures/controlled-native-cli-clock.ts',
				'scripts/verify-auth/owner-cli.ts',
				'--target',
				path.join(path.dirname(props.target.tokenCachePath), 'owner-cli-target.json'),
				'--no-browser',
				...props.args,
			],
			{ cwd: props.repositoryRoot, maxBuffer: 1024 * 1024 },
		);
		return { code: 0, ...output };
	} catch (error) {
		const failure = z
			.object({
				code: z.union([z.number(), z.string(), z.null()]),
				signal: z.string().nullable(),
				killed: z.boolean(),
				stdout: z.string(),
				stderr: z.string(),
			})
			.parse(error);
		const authorizationUrlPrinted = failure.stdout.includes('AUTHORIZATION_URL=');
		await recordAuthProofPhase({
			kind: 'cli-exit',
			code: failure.code,
			signal: failure.signal,
			killed: failure.killed,
			authorizationUrlPrinted,
			targetOrigin: new URL(props.target.issuer).origin,
		});
		if (typeof failure.code !== 'number' || failure.signal !== null || failure.killed)
			throw new Error(
				`Owner CLI did not exit normally (code=${String(failure.code)}, signal=${String(failure.signal)}, killed=${String(failure.killed)}, authorizationUrlPrinted=${String(authorizationUrlPrinted)}); termination is not an owner refusal`,
				{ cause: error },
			);
		return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
	}
}

/** Exercises the delivered entry, argument parsing, PKCE loopback and private cache, not only its login helper. */
export async function loginThroughNativeOwnerCli(props: {
	readonly target: AuthTarget;
	readonly repositoryRoot: string;
	readonly browser: (url: string) => Promise<readonly string[]>;
	readonly profile?: NativeOwnerCliProfile;
}): Promise<string> {
	const targetFile = path.join(path.dirname(props.target.tokenCachePath), 'owner-cli-target.json');
	await writeFile(targetFile, JSON.stringify(props.target), { mode: 0o600 });
	const profileFile =
		props.profile === undefined
			? undefined
			: path.join(
					path.dirname(targetFile),
					`native-cli-profile-${controlledSignInIds.nextId()}.json`,
				);
	if (profileFile !== undefined)
		await writeFile(profileFile, JSON.stringify(nativeOwnerCliProfileSchema.parse(props.profile)), {
			mode: 0o600,
			flag: 'wx',
		});
	const child = spawn(
		process.execPath,
		[
			'--import',
			'./packages/sign-in-test-support/src/test-fixtures/controlled-native-cli-clock.ts',
			'scripts/verify-auth/owner-cli.ts',
			'--target',
			targetFile,
			'--no-browser',
			...(props.profile?.authorization === 'allow-cache' ? [] : ['--force-auth']),
			'login',
		],
		{
			cwd: props.repositoryRoot,
			stdio: ['ignore', 'pipe', 'pipe'],
			...(profileFile === undefined
				? {}
				: { env: { ...process.env, AUTH_PROOF_NATIVE_PROFILE_FILE: profileFile } }),
		},
	);
	const ending = new Promise<number>((resolveEnd, rejectEnd) => {
		child.once('error', rejectEnd);
		child.once('exit', (code) => resolveEnd(code ?? 1));
	});
	const output: string[] = [];
	const sensitiveValues: string[] = [];
	const stdout = (async (): Promise<void> => {
		for await (const line of createInterface({ input: child.stdout })) {
			output.push(line);
			if (line.startsWith('AUTHORIZATION_URL='))
				sensitiveValues.push(...(await props.browser(line.slice('AUTHORIZATION_URL='.length))));
		}
	})();
	const stderr = (async (): Promise<void> => {
		for await (const line of createInterface({ input: child.stderr })) {
			output.push(line);
		}
	})();
	try {
		const [exitCode] = await Promise.all([ending, stdout, stderr]);
		const safeLines = new Set([
			...ownerLoginFailureLines,
			'Owner management credential ready. Each command still checks the live session.',
		]);
		process.stderr.write(
			`${JSON.stringify({ event: 'native-owner-login-result', exitCode, output: output.filter((line) => safeLines.has(line)).slice(0, 32), discardedLines: output.filter((line) => !safeLines.has(line)).length })}\n`,
		);
		if (exitCode !== 0) {
			const reason =
				ownerLoginFailureLines.find((candidate) =>
					output.some((line) => line.includes(candidate)),
				) ?? 'unclassified-native-failure';
			throw new Error(`Delivered native CLI failed (${exitCode}); ${reason}`);
		}
		const cached = cachedOwnerTokenSchema.parse(
			JSON.parse(await readFile(props.target.tokenCachePath, 'utf8')),
		);
		if (
			output.some((line) =>
				[cached.token, ...sensitiveValues].some((value) => value !== '' && line.includes(value)),
			)
		)
			throw new Error('Delivered native CLI logged a captured credential or authorization code');
		return cached.token;
	} finally {
		if (child.exitCode === null) child.kill('SIGTERM');
	}
}
