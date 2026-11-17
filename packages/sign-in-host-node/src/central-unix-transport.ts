import { request as sendHttpRequest } from 'node:http';
import { isAbsolute } from 'node:path';

import type { CentralTransport } from '@agent-collaboration/sign-in-core';

/** The logical URL supplies only the HTTP path; every connection uses the configured socket. */
export function createCentralUnixTransport(socketPath: string): CentralTransport {
	if (!isAbsolute(socketPath)) throw new TypeError('Central requires an absolute Unix socket path');
	return {
		async fetch(request: Request): Promise<Response> {
			const address = new URL(request.url);
			const body = ['GET', 'HEAD'].includes(request.method)
				? undefined
				: Buffer.from(await request.arrayBuffer());
			return new Promise<Response>((resolveResponse, rejectResponse): void => {
				const outgoing = sendHttpRequest(
					{
						socketPath,
						path: `${address.pathname}${address.search}`,
						method: request.method,
						headers: Object.fromEntries(request.headers),
						signal: request.signal,
						agent: false,
					},
					(incoming): void => {
						void (async (): Promise<void> => {
							try {
								const chunks: Buffer[] = [];
								for await (const chunk of incoming) {
									const bytes: unknown = chunk;
									if (!Buffer.isBuffer(bytes)) throw new Error('Invalid central response bytes');
									chunks.push(bytes);
								}
								const headers = new Headers();
								for (const [name, value] of Object.entries(incoming.headers)) {
									if (value === undefined) continue;
									for (const item of typeof value === 'string' ? [value] : value)
										headers.append(name, item);
								}
								const status = incoming.statusCode;
								if (status === undefined) throw new Error('Central response has no status');
								resolveResponse(
									new Response(
										request.method === 'HEAD' || [204, 205, 304].includes(status)
											? null
											: Buffer.concat(chunks),
										{ status, headers },
									),
								);
							} catch (error) {
								rejectResponse(error);
							}
						})();
					},
				);
				outgoing.once('error', rejectResponse);
				outgoing.end(body);
			});
		},
	};
}
