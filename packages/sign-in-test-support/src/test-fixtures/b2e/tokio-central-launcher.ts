import { access } from 'node:fs/promises';

import { z } from 'zod';

import {
	startCentralControlProcess,
	type CentralAnswer,
} from '#sign-in-test-support/test-fixtures/b2e/central-control-process';

/**
 * Real Tokio central with the sign-in link, from central's test-only launcher (codex-router
 * `crates/codex-router-debug-hosts/src/bin/central_sign_in_launcher.rs`, feature
 * `signin-test-support`). It speaks the shared control protocol; SIGTERM shuts it down and
 * removes the link socket.
 */
export interface TokioCentralSettings {
	readonly launcherPath: string;
	readonly root: string;
	readonly socket: string;
	readonly issuer: string;
	readonly audience: string;
	readonly adminAudience: string;
	readonly publicOrigin: string;
	readonly jwksUrl: string;
	readonly serviceId: string;
	/** Required by the launcher's flags for consumer compatibility; it creates nothing. */
	readonly legacyOrganization: string;
	/** The launcher clock's first instant, for every organization it opens. */
	readonly fixedTimeMs: number;
}

const readinessSchema = z.strictObject({ baseUrl: z.url(), socket: z.string().min(1) });

export interface TokioCentral {
	readonly baseUrl: string;
	readonly socket: string;
	readonly setTime: (milliseconds: number) => Promise<CentralAnswer>;
	readonly observe: (organization: string) => Promise<CentralAnswer>;
	readonly diagnostics: readonly string[];
	readonly pid: number;
	readonly exited: Promise<number | null>;
	readonly close: () => Promise<number | null>;
}

export async function startTokioCentral(settings: TokioCentralSettings): Promise<TokioCentral> {
	const central = await startCentralControlProcess({
		executable: settings.launcherPath,
		arguments: [
			['--root', settings.root],
			['--socket', settings.socket],
			['--issuer', settings.issuer],
			['--audience', settings.audience],
			['--admin-audience', settings.adminAudience],
			['--public-origin', settings.publicOrigin],
			['--jwks-url', settings.jwksUrl],
			['--service-id', settings.serviceId],
			['--legacy-organization', settings.legacyOrganization],
			['--fixed-time-ms', String(settings.fixedTimeMs)],
		].flat(),
		readinessSchema,
		shutdown: 'sigterm',
	});
	if (central.readiness.socket !== settings.socket) {
		await central.close();
		throw new Error('Central launcher bound another socket');
	}
	await access(central.readiness.socket);
	return {
		baseUrl: central.readiness.baseUrl,
		socket: central.readiness.socket,
		setTime: central.setTime,
		observe: central.observe,
		diagnostics: central.diagnostics,
		pid: central.pid,
		exited: central.exited,
		close: central.close,
	};
}
