// @vitest-environment jsdom
import { expect, it } from 'vitest';

import { organizationAdminPage } from '#sign-in-core/better-auth/organization-admin-page';

it.each([false, true])(
	'renders the owner-only People link only when permission is %s',
	async (showPeopleLink) => {
		const response = organizationAdminPage({
			organizationId: '019a3dce-2000-7000-8000-0000000000a1',
			organizationName: '<script>untrusted()</script>',
			operationId: '019a3dce-2000-7000-8000-0000000000a2',
			showPeopleLink,
		});
		const page = new DOMParser().parseFromString(await response.text(), 'text/html');
		expect(page.querySelector('h1')?.textContent).toBe('<script>untrusted()</script>');
		const link = page.querySelector('a');
		expect(link?.textContent ?? null).toBe(showPeopleLink ? 'People' : null);
		if (showPeopleLink)
			expect(link?.getAttribute('href')).toBe(
				'/api/auth/organization/people?organizationId=019a3dce-2000-7000-8000-0000000000a1',
			);
	},
);
