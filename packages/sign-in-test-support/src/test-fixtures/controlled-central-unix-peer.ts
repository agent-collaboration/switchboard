import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { ControlledCentralProvisioning } from '#sign-in-test-support/test-fixtures/controlled-central-provisioning';

/** The native peer is private and owns its socket directory; it opens no TCP listener. */
export async function startControlledCentralUnixPeer(
	protocol: ControlledCentralProvisioning,
): Promise<{
	readonly socketPath: string;
	readonly close: () => Promise<void>;
}> {
	const directory = await mkdtemp('/tmp/2026-11-central-link-');
	await chmod(directory, 0o700);
	const socketPath = join(directory, 'central.sock');
	const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse): void => {
		void (async (): Promise<void> => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) {
					const bytes: unknown = chunk;
					if (!Buffer.isBuffer(bytes)) throw new Error('Invalid central request bytes');
					chunks.push(bytes);
				}
				const method = incoming.method ?? 'GET';
				const headers = new Headers();
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (value === undefined) continue;
					for (const item of typeof value === 'string' ? [value] : value)
						headers.append(name, item);
				}
				// R-retrysignal: a client that closes before the reply aborts what the peer sees.
				const closed = new AbortController();
				outgoing.once('close', (): void => {
					if (!outgoing.writableFinished) closed.abort();
				});
				const response = await protocol.fetch(
					new Request(new URL(incoming.url ?? '/', 'http://central.invalid'), {
						method,
						headers,
						signal: closed.signal,
						...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }),
					}),
				);
				outgoing.writeHead(response.status, Object.fromEntries(response.headers));
				outgoing.end(Buffer.from(await response.arrayBuffer()));
			} catch {
				outgoing.destroy();
			}
		})();
	});
	try {
		await new Promise<void>((resolveListen, rejectListen): void => {
			server.once('error', rejectListen);
			server.listen(socketPath, resolveListen);
		});
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	process.stderr.write(
		`${JSON.stringify({
			event: 'controlled-central-socket-bound',
			platform: process.platform,
			socketPathBytes: Buffer.byteLength(socketPath),
		})}\n`,
	);
	return {
		socketPath,
		async close(): Promise<void> {
			await new Promise<void>((resolveClose): void => {
				server.close((): void => resolveClose());
				server.closeAllConnections();
			});
			await rm(directory, { recursive: true, force: true });
		},
	};
}
