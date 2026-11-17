import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { epochMillisecondsSchema } from '@agent-collaboration/sign-in-core';
import { afterEach, expect, it, vi } from 'vitest';

import { startNodeSignInListener } from '#sign-in-host-node/sign-in-http-listener';
import { createNodeSignInLogging } from '#sign-in-host-node/sign-in-logging';

vi.useFakeTimers({
	toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
});
vi.setSystemTime(2_208_988_800_000);
afterEach(() => vi.clearAllTimers());

it('exports bounded host records over OTLP and serves the same response when the collector is stopped', async () => {
	const received = Promise.withResolvers<string>();
	let exportedBodies = '';
	const collector = createServer((request, response): void => {
		void (async (): Promise<void> => {
			const chunks: Buffer[] = [];
			for await (const chunk of request)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
			exportedBodies += Buffer.concat(chunks).toString();
			if (exportedBodies.includes('listener-started') && exportedBodies.includes('captcha-refused'))
				received.resolve(exportedBodies);
		})();
	});
	await new Promise<void>((resolveListen) => collector.listen(0, '127.0.0.1', resolveListen));
	const collectorAddress = collector.address();
	if (collectorAddress === null || typeof collectorAddress === 'string')
		throw new Error('Collector setup failed');
	const output: string[] = [];
	const logging = createNodeSignInLogging({
		clock: { now: () => epochMillisecondsSchema.parse(2_208_988_800_000) },
		output: new Writable({
			write(chunk: Buffer, _encoding, callback): void {
				output.push(chunk.toString());
				callback();
			},
		}),
		endpoint: `http://127.0.0.1:${collectorAddress.port}`,
	});
	const opened = await startNodeSignInListener({
		hostname: '127.0.0.1',
		port: 0,
		issuer: 'https://issuer.invalid',
		clientAddress: { kind: 'socket-peer' },
		logging,
		handle: async () => Response.json({ result: 'unchanged' }),
	});
	if (opened.kind !== 'started') throw new Error('Listener setup failed');
	try {
		logging.log({ kind: 'captcha-refused', action: 'sign_in_social', reason: 'wrong-action' });
		const first = await fetch(new URL('/callback?code=request-canary', opened.listener.address), {
			headers: { authorization: 'Bearer credential-canary' },
		});
		expect(await first.json()).toEqual({ result: 'unchanged' });
		const exported = await received.promise;
		expect(exported).toContain('listener-started');
		expect(exported).toContain('sign-in-host-node');
		expect(exported).toContain('captcha-refused');
		expect(exported).toContain('sign_in_social');
		expect(exported).toContain('wrong-action');
		await new Promise<void>((resolveClose) => {
			collector.close(() => resolveClose());
			collector.closeAllConnections();
		});
		const second = await fetch(new URL('/callback?code=request-canary', opened.listener.address));
		expect(second.status).toBe(first.status);
		expect(await second.json()).toEqual({ result: 'unchanged' });
		for (const secret of ['request-canary', 'credential-canary', '/callback', 'issuer.invalid']) {
			expect(exported).not.toContain(secret);
			expect(output.join('')).not.toContain(secret);
		}
	} finally {
		await opened.listener.close();
		await logging.close();
		collector.closeAllConnections();
		collector.close();
		vi.useRealTimers();
	}
});
