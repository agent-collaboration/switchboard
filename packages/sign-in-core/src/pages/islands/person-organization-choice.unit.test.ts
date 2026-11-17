import { expect, it } from 'vitest';

import { switchPersonOrganization } from '#sign-in-core/pages/islands/person-organization-choice';

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
