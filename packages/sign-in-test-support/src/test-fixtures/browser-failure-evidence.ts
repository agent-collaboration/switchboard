import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { z } from 'zod';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

const pointerGesture = z.strictObject({
	event: z.enum(['mousedown', 'mouseup', 'click']),
	trusted: z.boolean(),
	expectedControl: z.boolean(),
	targetTag: z.string().regex(/^(?:[a-z][a-z0-9-]{0,31}|none)$/u),
	button: z.enum(['add-passkey', 'other-button', 'none']),
	clientX: z.number(),
	clientY: z.number(),
});

interface MeasuredButtonRect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

const summarizedRequestPaths = new Set([
	'/sign-in',
	'/owner-ready',
	'/organization-admin',
	'/api/auth/get-session',
	'/api/auth/sign-in/social',
	'/api/auth/callback/google',
	'/api/auth/two-factor/enable',
	'/api/auth/two-factor/verify-totp',
	'/api/auth/passkey/list-user-passkeys',
	'/api/auth/passkey/generate-register-options',
	'/api/auth/passkey/verify-registration',
	'/api/auth/passkey/generate-authenticate-options',
	'/api/auth/passkey/verify-authentication',
	'/api/auth/organization/create',
	'/api/auth/organization/set-active',
	'/api/auth/organization/people',
	'/api/auth/organization/people-list',
	'/api/auth/organization/person-membership',
]);

export const browserPointerBinding = 'reportProofBrowserPointer';

/** Retains only fields suitable for the public repository's failure artifact. */
export class BrowserFailureEvidence {
	private sequence = 0;
	private lastAwait = 'launch Chromium';
	private listCommit?: { readonly sequence: number; readonly controlledMilliseconds: number };
	private measuredButton?: MeasuredButtonRect & { readonly sequence: number };
	private readonly pointerGestures: (z.infer<typeof pointerGesture> & {
		readonly sequence: number;
	})[] = [];
	private lastNetworkRequest?: string;

	constructor(private readonly evidenceDirectory: string) {}

	async observePage(page: Page, origin: string | undefined): Promise<void> {
		await page.exposeBinding(browserPointerBinding, ({ frame }, value: unknown): void => {
			const gesture = pointerGesture.safeParse(value);
			if (frame === page.mainFrame() && gesture.success && this.pointerGestures.length < 3)
				this.pointerGestures.push({ ...gesture.data, sequence: ++this.sequence });
		});
		page.on('request', (request): void => {
			const url = new URL(request.url());
			if (url.origin !== origin) return;
			const route = summarizedRequestPaths.has(url.pathname) ? url.pathname : '[route omitted]';
			this.lastNetworkRequest = `${request.method()} ${route}`;
		});
	}

	waitFor(operation: string): void {
		this.lastAwait = operation;
	}

	recordListCommit(): void {
		this.listCommit = {
			sequence: ++this.sequence,
			controlledMilliseconds: controlledSignInClock.now(),
		};
	}

	recordMeasurement(rect: MeasuredButtonRect): void {
		this.measuredButton = { ...rect, sequence: ++this.sequence };
		this.pointerGestures.length = 0;
	}

	observedTrustedClick(): boolean {
		return this.pointerGestures.some(
			(pointer) => pointer.event === 'click' && pointer.trusted && pointer.expectedControl,
		);
	}

	async writeOnFailure(): Promise<void> {
		const directory = path.join(
			process.env.RUNNER_TEMP ?? tmpdir(),
			'switchboard-browser-failures',
		);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const output = [
			`last await = ${this.lastAwait}`,
			`list commit = ${this.listCommit === undefined ? 'never' : JSON.stringify(this.listCommit)}`,
			`measured button rect = ${this.measuredButton === undefined ? 'never' : JSON.stringify(this.measuredButton)}`,
			`actual pointer gestures = ${JSON.stringify(this.pointerGestures)}`,
			`last network request = ${this.lastNetworkRequest ?? 'never'}`,
		].join('\n');
		await writeFile(
			path.join(directory, `${path.basename(this.evidenceDirectory)}.txt`),
			`${output}\n`,
			{
				flag: 'wx',
				mode: 0o600,
			},
		);
	}
}
