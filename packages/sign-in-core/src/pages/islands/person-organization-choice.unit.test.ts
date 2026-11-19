// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import {
	PersonOrganizationChoice,
	switchPersonOrganization,
} from '#sign-in-core/pages/islands/person-organization-choice';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

it('enables membership choices when the mounted island owns submission', async (): Promise<void> => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	try {
		await React.act(async (): Promise<void> => {
			root.render(
				React.createElement(PersonOrganizationChoice, {
					activeOrganizationId: null,
					choices: [
						{
							organizationId: organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a1'),
							organizationName: 'First organization',
							role: 'owner',
						},
						{
							organizationId: organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a2'),
							organizationName: 'Second organization',
							role: 'member',
						},
					],
				}),
			);
		});
		expect(container.querySelectorAll('#choose-organization button')).toHaveLength(2);
		expect(container.querySelectorAll('#choose-organization button:not([disabled])')).toHaveLength(
			2,
		);
	} finally {
		await React.act(async (): Promise<void> => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});

it.each(['success', 'refused', 'lost-reply'] as const)(
	're-renders the server page after %s without replaying the switch',
	async (ending) => {
		const actions: string[] = [];
		await switchPersonOrganization('019a3dce-2000-7000-8000-0000000000a1', {
			setActive: async (organizationId: string): Promise<{ readonly ok: boolean }> => {
				actions.push(`switch:${organizationId}`);
				if (ending === 'lost-reply')
					throw new Error('Response lost after the server may have committed');
				return { ok: ending === 'success' };
			},
			replace: (): void => {
				actions.push('replace');
			},
			showRefusal: (): void => {
				actions.push('refusal');
			},
		});
		expect(actions).toEqual([
			`switch:019a3dce-2000-7000-8000-0000000000a1`,
			...(ending === 'refused' ? ['refusal'] : []),
			'replace',
		]);
	},
);
