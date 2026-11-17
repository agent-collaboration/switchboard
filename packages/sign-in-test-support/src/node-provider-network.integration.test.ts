import { createServer } from 'node:http';

import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { withNodeProviderNetwork } from '#sign-in-test-support/test-fixtures/node-provider-network';

useControlledSignInClock();

async function providerFixtureAnswer(name: string): Promise<string> {
	return withNodeProviderNetwork(
		async () => Response.json({ fixture: name }),
		async () => {
			const result = await fetch('https://oauth2.googleapis.com/token');
			return JSON.stringify(await result.json());
		},
	);
}

it('keeps non-provider request bodies unchanged and separates overlapping provider fixtures', async () => {
	const server = createServer((request, response): void => {
		void (async (): Promise<void> => {
			const chunks: Buffer[] = [];
			for await (const chunk of request)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			response.writeHead(200).end(Buffer.concat(chunks));
		})();
	});
	await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('Fixture listener failed');
	try {
		const response = await fetch(
			new Request(`http://127.0.0.1:${address.port}`, {
				method: 'POST',
				body: 'unaltered-request-body',
			}),
		);
		expect(await response.text()).toBe('unaltered-request-body');
		let forwarded = 0;
		const localProviderUrl = `http://127.0.0.1:${address.port}/siteverify`;
		const externalResponse = await withNodeProviderNetwork(
			async (request) => {
				forwarded += 1;
				return fetch(request);
			},
			async () => fetch(localProviderUrl, { method: 'POST', body: 'unaltered-provider-body' }),
			[localProviderUrl],
		);
		expect(forwarded).toBe(1);
		expect(await externalResponse.text()).toBe('unaltered-provider-body');
		expect(
			await Promise.all([providerFixtureAnswer('first'), providerFixtureAnswer('second')]),
		).toEqual(['{"fixture":"first"}', '{"fixture":"second"}']);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
});
