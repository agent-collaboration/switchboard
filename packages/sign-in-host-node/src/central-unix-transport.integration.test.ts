import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createCentralUnixTransport } from '#sign-in-host-node/central-unix-transport';

it('carries the request and central answer through only the configured private Unix socket', async (): Promise<void> => {
	// Arrange: the test peer owns a private socket; the URL has no reachable host.
	const directory = await mkdtemp(join(tmpdir(), 'sign-in-central-link-'));
	await chmod(directory, 0o700);
	const socketPath = join(directory, 'central.sock');
	const received = Promise.withResolvers<{
		readonly method: string | undefined;
		readonly path: string | undefined;
		readonly authorization: string | undefined;
		readonly body: string;
	}>();
	const server = createServer((request, response): void => {
		void (async (): Promise<void> => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of request) {
					const input: unknown = chunk;
					if (!Buffer.isBuffer(input)) throw new Error('Expected request bytes');
					chunks.push(input);
				}
				received.resolve({
					method: request.method,
					path: request.url,
					authorization: request.headers.authorization,
					body: Buffer.concat(chunks).toString('utf8'),
				});
				response.writeHead(201, {
					'content-type': 'application/json',
					'x-central-answer': 'confirmed',
				});
				response.end('{"transport":"unix"}');
			} catch (error) {
				received.reject(error);
				response.destroy();
			}
		})();
	});
	try {
		await new Promise<void>((resolveListen, rejectListen): void => {
			server.once('error', rejectListen);
			server.listen(socketPath, resolveListen);
		});
		const transport = createCentralUnixTransport(socketPath);

		// Act: the URL supplies an HTTP path, never a network destination.
		const response = await transport.fetch(
			new Request('http://central.invalid/transport-probe?attempt=1', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer controlled-proof' },
				body: '{"probe":"request"}',
			}),
		);

		// Assert: a successful response alone cannot hide a missing request or body.
		expect(response.status).toBe(201);
		expect(response.headers.get('x-central-answer')).toBe('confirmed');
		expect(await response.json()).toEqual({ transport: 'unix' });
		expect(await received.promise).toEqual({
			method: 'POST',
			path: '/transport-probe?attempt=1',
			authorization: 'Bearer controlled-proof',
			body: '{"probe":"request"}',
		});
	} finally {
		await new Promise<void>((resolveClose): void => {
			server.close((): void => resolveClose());
			server.closeAllConnections();
		});
		await rm(directory, { recursive: true, force: true });
	}
});
