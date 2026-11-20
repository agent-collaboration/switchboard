// @vitest-environment jsdom
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
	OrganizationPeople,
	type OrganizationPeopleTransport,
} from '#sign-in-core/pages/islands/organization-people';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const organizationId = organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a1');
const otherOrganizationId = organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a2');
let root: Root;
beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	document.body.replaceChildren();
	const container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await React.act(async (): Promise<void> => {
		root.unmount();
	});
	vi.unstubAllGlobals();
});

function deferred(): {
	readonly promise: Promise<unknown>;
	readonly resolve: (reply: unknown) => void;
} {
	let fulfill: ((reply: unknown) => void) | undefined;
	const promise = new Promise<unknown>((resolve): void => {
		fulfill = resolve;
	});
	return {
		promise,
		resolve: (reply: unknown): void => {
			if (fulfill === undefined) throw new Error('Promise not initialized');
			fulfill(reply);
		},
	};
}
function page(email: string, nextOffset: number | null = null): unknown {
	return {
		kind: 'available',
		members: [{ name: 'Test person', email, role: 'member' }],
		memberTotal: 101,
		nextOffset,
		invitations: [{ email: 'invited@example.invalid', role: 'member' }],
	};
}
async function render(
	transport: OrganizationPeopleTransport,
	selectedOrganizationId = organizationId,
): Promise<void> {
	await React.act(async (): Promise<void> => {
		root.render(
			React.createElement(OrganizationPeople, {
				organizationId: selectedOrganizationId,
				organizationName: 'Test organization',
				transport,
			}),
		);
	});
}
function button(label: string): HTMLButtonElement {
	const found = [...document.querySelectorAll('button')].find(
		(candidate) =>
			candidate.getAttribute('aria-label') === label || candidate.textContent === label,
	);
	if (found === undefined) throw new Error(`Missing button: ${label}`);
	return found;
}
async function click(label: string): Promise<void> {
	await React.act(async (): Promise<void> => {
		button(label).click();
	});
}
function membershipResult(): string {
	return document.querySelector('[aria-label="Membership result"]')?.textContent ?? '';
}

it('requests page 100 while page 50 is pending and refuses the older response', async () => {
	const held = deferred();
	const offsets: number[] = [];
	const transport: OrganizationPeopleTransport = {
		list: async (request): Promise<unknown> => {
			offsets.push(request.offset);
			return request.offset === 0
				? page('zero@example.invalid', 50)
				: request.offset === 50
					? held.promise
					: page('hundred@example.invalid');
		},
		lookup: async (): Promise<unknown> => ({ kind: 'not-member' }),
	};
	await render(transport);
	await click('Next');
	expect(button('Next').disabled).toBe(false);
	await click('Next');
	expect(offsets).toEqual([0, 50, 100]);
	expect(document.querySelector('[aria-label="Members"]')?.textContent).toContain(
		'hundred@example.invalid',
	);
	await React.act(async (): Promise<void> => {
		held.resolve(page('fifty@example.invalid', 100));
	});
	expect(document.querySelector('[aria-label="Members"]')?.textContent).toContain(
		'hundred@example.invalid',
	);
	expect(document.querySelector('[aria-label="Members"]')?.textContent).not.toContain(
		'fifty@example.invalid',
	);
});
it('picks rows through the checked lookup, clears on a newer request and ignores the late first reply', async () => {
	const held = deferred();
	const emails: string[] = [];
	const transport: OrganizationPeopleTransport = {
		list: async (): Promise<unknown> => page('member@example.invalid'),
		lookup: async (request): Promise<unknown> => {
			emails.push(request.email);
			return request.email === 'member@example.invalid' ? held.promise : { kind: 'invited' };
		},
	};
	await render(transport);
	await click('Look up member@example.invalid');
	expect(membershipResult()).toBe('Looking up…');
	expect(button('Look up').disabled).toBe(true);
	await click('Look up');
	expect(emails).toEqual(['member@example.invalid']);
	await click('Look up invited@example.invalid');
	expect(membershipResult()).toBe('Invited');
	await React.act(async (): Promise<void> => {
		held.resolve({ kind: 'member', role: 'member' });
	});
	expect(membershipResult()).toBe('Invited');
});
it.each(['refused', 'malformed', 'network'] as const)(
	'clears an earlier answer when the next lookup is %s',
	async (ending) => {
		let calls = 0;
		const transport: OrganizationPeopleTransport = {
			list: async (): Promise<unknown> => page('member@example.invalid'),
			lookup: async (): Promise<unknown> => {
				calls += 1;
				if (calls === 1) return { kind: 'member', role: 'owner' };
				if (ending === 'network') throw new Error('Network lost');
				return ending === 'refused' ? { kind: 'refused' } : { kind: 'member', role: 'unknown' };
			},
		};
		await render(transport);
		await click('Look up member@example.invalid');
		expect(membershipResult()).toBe('Member · Owner');
		await click('Look up invited@example.invalid');
		expect(membershipResult()).toBe(
			ending === 'refused' ? 'Lookup refused.' : 'Lookup unavailable. Try again.',
		);
		expect(membershipResult()).not.toContain('Owner');
	},
);
it('disposes both instances when the organization changes and clears field and result', async () => {
	const held = deferred();
	const transport: OrganizationPeopleTransport = {
		list: async (): Promise<unknown> => page('member@example.invalid'),
		lookup: async (): Promise<unknown> => held.promise,
	};
	await render(transport);
	await click('Look up member@example.invalid');
	await render(transport, otherOrganizationId);
	expect(document.querySelector<HTMLInputElement>('#membership-email')?.value).toBe('');
	expect(membershipResult()).toBe('');
	await React.act(async (): Promise<void> => {
		held.resolve({ kind: 'member', role: 'owner' });
	});
	expect(membershipResult()).toBe('');
});

it('clears a displayed result as soon as the email changes and refuses invalid input without a read', async () => {
	let reads = 0;
	const transport: OrganizationPeopleTransport = {
		list: async (): Promise<unknown> => page('member@example.invalid'),
		lookup: async (): Promise<unknown> => {
			reads += 1;
			return { kind: 'member', role: 'member' };
		},
	};
	await render(transport);
	await click('Look up member@example.invalid');
	expect(membershipResult()).toBe('Member · Member');
	const input = document.querySelector<HTMLInputElement>('#membership-email');
	if (input === null) throw new Error('Missing email input');
	await React.act(async (): Promise<void> => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
			input,
			'invalid',
		);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	expect(membershipResult()).toBe('');
	await click('Look up');
	expect(membershipResult()).toBe('Enter a valid email.');
	expect(reads).toBe(1);
});
