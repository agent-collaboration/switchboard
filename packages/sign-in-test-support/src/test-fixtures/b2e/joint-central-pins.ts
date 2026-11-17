import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

/**
 * The central build B2e runs against provides signed workspace setup, unique names,
 * stored stamp facts, a test-only launcher and workerd bridge controls. Each artifact
 * is pinned by SHA-256 and built from the commit below using its Cargo and worker-build
 * recipes. A run refuses other bytes, so its receipt identifies the build exercised.
 */
export const jointCentralPin = {
	commit: 'ea030e51350a457d061fa8b913f483ed0d289279',
	branch: 'main',
	native: {
		/** `cargo build --locked -p codex-router-debug-hosts --features signin-test-support`. */
		launcher: {
			file: 'central_sign_in_launcher',
			acceptedBuilds: {
				// Built with the locked Cargo recipe above, then signed for direct execution
				// using codex-router/scripts/cargo_debug_signing_runner.sh --sign-only.
				signedForDirectExecution:
					'9c2629e04441639f0682b85b339ef77d1524315b01fb91cc3dc78680c229ff5c',
			},
		},
	},
	workerd: {
		/** Built in the pinned checkout by CI's lines (`ci.yml` 761-762); paths are checkout-relative. */
		bundles: {
			centralScript: {
				file: 'crates/collaboration-central-cloudflare/build-test-support/index.js',
				sha256: '8495325fc1a005a3359b00bc00eadfc2560b59faa78fdd743e0523ff365960e9',
			},
			centralWasm: {
				file: 'crates/collaboration-central-cloudflare/build-test-support/index_bg.wasm',
				sha256: '5ccf4aac2ba9c7d035e8e504ac598b8bb8c5f3a7aa8e159e103e72a11933d107',
			},
			linkScript: {
				file: 'crates/collaboration-central-cloudflare/build-link-test-support/index.js',
				sha256: 'd3b75e3235f6559b1523acd5d320b236c3ea7641fd70cd0536d6e79a3cfe20dd',
			},
			linkWasm: {
				file: 'crates/collaboration-central-cloudflare/build-link-test-support/index_bg.wasm',
				sha256: 'ec2708c78aa7e3d255b3ca1a2bd52038241620da0fafdc948949a398edeebc19',
			},
		},
		/** Central's own bridge at the pinned commit; it starts `verification/targets/workerd-storage.ts`. */
		bridge: 'crates/collaboration-central-cloudflare/tests/support/workerd-bridge.mts',
		lockfileSha256: '0a356aa06637db007f10197c7cc4e42f30c3fa2cc2b4e55a4419d2d0812000de',
		miniflareVersion: '5.20261012.0-beta',
		workerdVersion: '1.20261012.1',
		/** `verification/package.json` engines. */
		nodeVersion: 'v26.11.1',
	},
} as const;

/** The artifacts directory holding the native launcher, when B2e is selected at all. */
export function jointArtifactsDirectory(): string | null {
	const directory = process.env.B2E_CENTRAL_ARTIFACTS;
	return directory === undefined || directory === '' ? null : directory;
}

async function sha256Of(filePath: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(filePath))
		.digest('hex');
}

/**
 * The native launcher, verified by hash against every accepted build. Throws on a missing file
 * or any other bytes, so a selected B2e run never skips or runs against an unpinned build.
 */
export async function requireJointLauncher(
	directory: string,
): Promise<{ readonly launcher: string; readonly launcherBuild: string }> {
	const { launcher } = jointCentralPin.native;
	const launcherPath = path.join(directory, launcher.file);
	const actual = await sha256Of(launcherPath);
	const launcherBuild = Object.entries(launcher.acceptedBuilds).find(
		([, sha256]) => sha256 === actual,
	)?.[0];
	if (launcherBuild === undefined)
		throw new Error(`B2e launcher ${launcher.file} is not a pinned build (${actual})`);
	// The receipt names the native build that actually ran.
	process.stderr.write(`B2e central launcher build: ${launcherBuild} (${actual})\n`);
	return { launcher: launcherPath, launcherBuild };
}

/** The codex-router checkout the workerd pairing runs central's bridge from. */
export function jointCentralCheckoutDirectory(): string | null {
	const directory = process.env.B2E_CENTRAL_CHECKOUT;
	return directory === undefined || directory === '' ? null : directory;
}

/** The Node that runs central's bridge, at the version `verification/` declares. */
export function jointCentralNode(): string | null {
	const executable = process.env.B2E_CENTRAL_NODE;
	return executable === undefined || executable === '' ? null : executable;
}

export interface JointCentralCheckout {
	readonly directory: string;
	readonly bridge: string;
	readonly node: string;
}

const runFile = promisify(execFile);
const packageVersionSchema = z.looseObject({ version: z.string() });

/**
 * Refuses any checkout other than the pinned commit with a clean tree (worker-build writes its
 * own ignore file into each bundle directory), the pinned bundles, lockfile, Miniflare and
 * workerd installed, and the declared Node, so a workerd receipt names exactly what ran.
 */
export async function requireJointCentralCheckout(props: {
	readonly directory: string;
	readonly node: string;
}): Promise<JointCentralCheckout> {
	const { directory } = props;
	const { workerd } = jointCentralPin;
	const head = (await runFile('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
	if (head !== jointCentralPin.commit)
		throw new Error(`B2e central checkout is at ${head}, not the pinned ${jointCentralPin.commit}`);
	const changes = (await runFile('git', ['-C', directory, 'status', '--porcelain'])).stdout.trim();
	if (changes !== '') throw new Error('B2e central checkout has local changes');
	await Promise.all(
		Object.values(workerd.bundles).map(async (bundle) => {
			const actual = await sha256Of(path.join(directory, bundle.file));
			if (actual !== bundle.sha256)
				throw new Error(`B2e bundle ${bundle.file} is not the pinned build (${actual})`);
		}),
	);
	const verification = path.join(directory, 'verification');
	const lockfileSha256 = await sha256Of(path.join(verification, 'pnpm-lock.yaml'));
	if (lockfileSha256 !== workerd.lockfileSha256)
		throw new Error(`B2e verification lockfile is not the pinned one (${lockfileSha256})`);
	const installed = async (name: 'miniflare' | 'workerd'): Promise<string> =>
		packageVersionSchema.parse(
			JSON.parse(
				await readFile(path.join(verification, 'node_modules', name, 'package.json'), 'utf8'),
			),
		).version;
	const [miniflareVersion, workerdVersion] = await Promise.all([
		installed('miniflare'),
		installed('workerd'),
	]);
	if (miniflareVersion !== workerd.miniflareVersion)
		throw new Error(`B2e miniflare is ${miniflareVersion}, not the pinned build`);
	if (workerdVersion !== workerd.workerdVersion)
		throw new Error(`B2e workerd is ${workerdVersion}, not the pinned build`);
	const nodeVersion = (await runFile(props.node, ['--version'])).stdout.trim();
	if (nodeVersion !== workerd.nodeVersion)
		throw new Error(`B2e bridge Node is ${nodeVersion}, not ${workerd.nodeVersion}`);
	return { directory, bridge: path.join(directory, workerd.bridge), node: props.node };
}
