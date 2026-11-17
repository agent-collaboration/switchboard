// @vitest-environment jsdom
import { Toaster } from '@agent-collaboration/tool-access-ui/ui/sonner';
import { AuthProvider } from '@auth-ui/components/auth/auth-provider';
import { ConfirmSecondFactorStep } from '@auth-ui/components/auth/two-factor/confirm-second-factor-step';
import { twoFactorPlugin } from '@auth-ui/lib/auth/two-factor-plugin';
import type { AuthClient } from '@better-auth-ui/core';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const labels = {
	appCodeDescription: 'Enter the code from your app.',
	confirm: 'Confirm',
	recoveryCode: 'Recovery code',
	recoveryCodeDescription: 'Enter a recovery code.',
	useRecoveryCode: 'Use a recovery code instead',
	useAppCode: 'Use your authenticator app instead',
};

/** What Better Auth's client throws with `throw: true`: the HTTP status and
 * Better Auth's error body (`code`, `message`). */
function betterAuthRefusal(status: number, code: string, message: string): Error {
	return Object.assign(new Error(message), {
		status,
		statusText: message,
		error: { code, message },
	});
}

/** The injected auth client is the component's boundary; only the two-factor
 * calls it makes are answered, each with the refusal under test. */
function refusingClient(refusal: Error): AuthClient {
	const refuse = async (): Promise<never> => {
		throw refusal;
	};
	const client = {
		twoFactor: { verifyTotp: vi.fn(refuse), verifyBackupCode: vi.fn(refuse) },
		getSession: vi.fn(async () => ({ data: null, error: null })),
		$store: { listen: () => () => undefined, notify: () => undefined, atoms: {} },
	};
	return client as unknown as AuthClient;
}

function renderStep(authClient: AuthClient): ReactElement {
	return createElement(
		AuthProvider,
		{
			authClient,
			queryClient: new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
			navigate: () => undefined,
			Link: (props: { href: string; children?: React.ReactNode }) =>
				createElement('a', { href: props.href }, props.children),
			plugins: [twoFactorPlugin({ allowPasswordless: true })],
		},
		createElement(ConfirmSecondFactorStep, { onConfirmed: () => undefined, labels }),
		createElement(Toaster),
	);
}

beforeEach(() => {
	vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: (): void => {},
		removeListener: (): void => {},
		addEventListener: (): void => {},
		removeEventListener: (): void => {},
		dispatchEvent: (): boolean => true,
	}));
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		},
	);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Better Auth UI's default (owner decision C2 = B, 13 Nov): a refusal shows
 * inline in the form and in one toast, both in Better Auth's own words. */
async function refusedRecoveryCode(refusal: Error): Promise<void> {
	render(renderStep(refusingClient(refusal)));
	fireEvent.click(screen.getByRole('button', { name: labels.useRecoveryCode }));
	fireEvent.change(screen.getByLabelText(labels.recoveryCode), { target: { value: 'used-code' } });
	fireEvent.click(screen.getByRole('button', { name: labels.confirm }));
}

const toasts = (): string[] =>
	[...document.querySelectorAll('[data-sonner-toast]')].map((toast) => toast.textContent ?? '');

it("shows a refused recovery code inline and in one toast, in Better Auth's words", async () => {
	await refusedRecoveryCode(betterAuthRefusal(401, 'INVALID_BACKUP_CODE', 'Invalid backup code'));

	await waitFor(() => expect(toasts()).toHaveLength(1));
	expect(toasts()[0]).toContain('Invalid backup code');
	const inline = [...document.querySelectorAll('form [data-slot="field-error"]')].map(
		(node) => node.textContent,
	);
	expect(inline).toEqual(['Invalid backup code']);
});

it('shows any other refusal the same way, in its own words', async () => {
	await refusedRecoveryCode(
		betterAuthRefusal(429, 'TOO_MANY_REQUESTS', 'Too many requests. Try again later.'),
	);

	await waitFor(() => expect(toasts()).toHaveLength(1));
	expect(toasts()[0]).toContain('Too many requests. Try again later.');
	expect(
		[...document.querySelectorAll('form [data-slot="field-error"]')].map(
			(node) => node.textContent,
		),
	).toEqual(['Too many requests. Try again later.']);
});
