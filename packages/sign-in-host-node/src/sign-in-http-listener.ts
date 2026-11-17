import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
	signInClientIpv6SubnetBits,
	trustedSignInClientAddressHeader,
} from '@agent-collaboration/sign-in-core';
import { getIPFromHeader } from '@better-auth/core/utils/ip';

import type { NodeSignInLogging } from '#sign-in-host-node/sign-in-logging';
import {
	readTrustedClientAddress,
	type TrustedClientAddress,
} from '#sign-in-host-node/trusted-client-address';

export interface NodeSignInListener {
	readonly address: URL;
	readonly close: () => Promise<void>;
}

export type StartNodeSignInListenerResult =
	| { readonly kind: 'started'; readonly listener: NodeSignInListener }
	| { readonly kind: 'unavailable'; readonly reason: 'listener-error' };

async function receiveRequest(props: {
	readonly request: IncomingMessage;
	readonly issuer: string;
	readonly clientAddress: TrustedClientAddress;
}): Promise<Request | null> {
	const pathname = props.request.url ?? '/';
	if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
	const address = readTrustedClientAddress({
		peerAddress: props.request.socket.remoteAddress,
		headers: props.request.headers,
		policy: props.clientAddress,
	});
	if (address.kind === 'unavailable') return null;
	const headers = new Headers();
	for (const [name, value] of Object.entries(props.request.headers)) {
		if (value === undefined || name === trustedSignInClientAddressHeader) continue;
		for (const item of typeof value === 'string' ? [value] : value) headers.append(name, item);
	}
	const normalizedAddress = getIPFromHeader(address.address, {
		ipv6Subnet: signInClientIpv6SubnetBits,
	});
	if (normalizedAddress !== null) headers.set(trustedSignInClientAddressHeader, normalizedAddress);
	const chunks: Buffer[] = [];
	for await (const chunk of props.request)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const method = props.request.method ?? 'GET';
	return new Request(new URL(pathname, props.issuer), {
		method,
		headers,
		...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }),
	});
}

async function sendResponse(response: Response, outgoing: ServerResponse): Promise<void> {
	const headers = Object.fromEntries(response.headers);
	const cookies = response.headers.getSetCookie();
	delete headers['set-cookie'];
	outgoing.writeHead(response.status, {
		...headers,
		...(cookies.length === 0 ? {} : { 'set-cookie': cookies }),
	});
	if (response.body !== null)
		for await (const chunk of response.body) {
			if (!outgoing.write(chunk))
				await new Promise<void>((resolveDrain, rejectDrain) => {
					outgoing.once('drain', resolveDrain);
					outgoing.once('error', rejectDrain);
				});
		}
	outgoing.end();
}

export async function startNodeSignInListener(props: {
	readonly hostname: string;
	readonly port: number;
	readonly issuer: string;
	readonly clientAddress: TrustedClientAddress;
	readonly handle: (request: Request) => Promise<Response>;
	readonly logging: NodeSignInLogging;
}): Promise<StartNodeSignInListenerResult> {
	const server = createServer((request, outgoing): void => {
		void (async (): Promise<void> => {
			try {
				const incoming = await receiveRequest({
					request,
					issuer: props.issuer,
					clientAddress: props.clientAddress,
				});
				const response =
					incoming === null
						? Response.json({ error: 'invalid-request' }, { status: 400 })
						: await props.handle(incoming);
				await sendResponse(response, outgoing);
				props.logging.log({ kind: 'request-completed', status: response.status });
			} catch {
				props.logging.log({ kind: 'request-failed', reason: 'transport-error' });
				if (outgoing.headersSent) outgoing.destroy();
				else
					outgoing
						.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
						.end('{"error":"sign-in-unavailable"}');
			}
		})();
	});
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once('error', rejectListen);
			server.listen(props.port, props.hostname, resolveListen);
		});
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('Missing TCP listener');
		props.logging.log({ kind: 'listener-started' });
		let closing: Promise<void> | undefined;
		return {
			kind: 'started',
			listener: {
				address: new URL(
					`http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`,
				),
				close(): Promise<void> {
					closing ??= new Promise<void>((resolveClose) => {
						server.close(() => {
							props.logging.log({ kind: 'listener-stopped' });
							resolveClose();
						});
						server.closeAllConnections();
					});
					return closing;
				},
			},
		};
	} catch {
		server.close();
		return { kind: 'unavailable', reason: 'listener-error' };
	}
}
