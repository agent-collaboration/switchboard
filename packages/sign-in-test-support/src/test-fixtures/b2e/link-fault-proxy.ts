import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import {
	createServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { join } from 'node:path';

/**
 * B2e's one fault seam, between sign-in and real central's link. It forwards request bytes
 * unchanged. It can hold one selected request before forwarding (the revocation ordering
 * barrier), or drop the reply to one selected request after central answered it
 * successfully (the lost ACK). It never manufactures an answer. The same control serves the
 * Node pairing's socket proxy and the workerd pairing's fetch hop in front of central's bridge.
 */
export type LinkFaultEvent =
	| {
			readonly kind: 'forwarded';
			readonly path: string;
			readonly bodySha256: string;
			readonly status: number;
	  }
	| { readonly kind: 'held'; readonly path: string; readonly bodySha256: string }
	| { readonly kind: 'released'; readonly path: string; readonly bodySha256: string }
	| {
			readonly kind: 'reply-dropped';
			readonly path: string;
			readonly bodySha256: string;
			readonly status: number;
			readonly replySha256: string;
	  };

/** Which request a hold or drop applies to: its link path and its exact parsed body. */
export type LinkRequestMatch = (request: {
	readonly path: string;
	readonly body: unknown;
}) => boolean;

/** One reply central sent over the link, as the hop received it. */
export interface LinkReply {
	readonly status: number;
	/** The reply parsed as JSON, or null when it is not JSON. */
	readonly body: unknown;
	/** The exact reply bytes' SHA-256 and length, so a replay can be compared byte for byte. */
	readonly bodySha256: string;
	readonly bodyLength: number;
}

export interface LinkFaultControl {
	readonly events: readonly LinkFaultEvent[];
	/** The next matching request waits before reaching central until `release` is called. */
	readonly holdNext: (match: LinkRequestMatch) => {
		readonly entered: Promise<void>;
		readonly release: () => void;
	};
	/** The next matching request reaches central; a successful reply is then dropped. */
	readonly dropReplyOfNext: (match: LinkRequestMatch) => { readonly dropped: Promise<void> };
	/**
	 * Every later matching request's delivered reply, exactly as central sent it, in order: its
	 * status and its JSON body (null when the body is not JSON). Dropped replies are not added.
	 */
	readonly captureReplies: (match: LinkRequestMatch) => readonly LinkReply[];
	/**
	 * Called by the hop before forwarding: waits out any hold and opens an exchange that
	 * remembers the request and any armed drop.
	 */
	readonly beforeForward: (request: {
		readonly path: string;
		readonly body: Uint8Array;
	}) => Promise<{ readonly exchange: string }>;
	/** Called by the hop with central's answer: `drop` only for an armed drop on a 200. */
	readonly afterForward: (answer: {
		readonly exchange: string;
		readonly status: number;
		readonly reply: Uint8Array;
	}) => 'deliver' | 'drop';
}

export interface LinkFaultProxy extends Pick<
	LinkFaultControl,
	'events' | 'holdNext' | 'dropReplyOfNext' | 'captureReplies'
> {
	readonly socketPath: string;
	readonly close: () => Promise<void>;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function parsedJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

function linkRequestOf(
	path: string,
	body: Uint8Array,
): { readonly path: string; readonly body: unknown } {
	return { path: new URL(path, 'http://central.invalid').pathname, body: parsedJson(body) };
}
function takeFirstMatching<TArmed extends { readonly match: LinkRequestMatch }>(
	armed: TArmed[],
	request: { readonly path: string; readonly body: unknown },
): TArmed | undefined {
	const index = armed.findIndex((entry) => entry.match(request));
	return index === -1 ? undefined : armed.splice(index, 1)[0];
}

export function createLinkFaultControl(): LinkFaultControl {
	const events: LinkFaultEvent[] = [];
	const holds: {
		readonly match: LinkRequestMatch;
		readonly entered: () => void;
		readonly released: Promise<void>;
	}[] = [];
	const drops: { readonly match: LinkRequestMatch; readonly dropped: () => void }[] = [];
	const exchanges = new Map<
		string,
		{
			readonly path: string;
			readonly bodySha256: string;
			readonly drop: { readonly match: LinkRequestMatch; readonly dropped: () => void } | null;
			readonly captures: LinkReply[][];
		}
	>();
	let exchangeCount = 0;
	const captures: { readonly match: LinkRequestMatch; readonly replies: LinkReply[] }[] = [];
	return {
		events,
		holdNext(match) {
			const entered = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			holds.push({ match, entered: entered.resolve, released: released.promise });
			return { entered: entered.promise, release: released.resolve };
		},
		captureReplies(match) {
			const replies: LinkReply[] = [];
			captures.push({ match, replies });
			return replies;
		},
		dropReplyOfNext(match) {
			const dropped = Promise.withResolvers<void>();
			drops.push({ match, dropped: dropped.resolve });
			return { dropped: dropped.promise };
		},
		async beforeForward({ path, body }) {
			const request = linkRequestOf(path, body);
			const bodySha256 = sha256(body);
			const hold = takeFirstMatching(holds, request);
			if (hold !== undefined) {
				events.push({ kind: 'held', path: request.path, bodySha256 });
				hold.entered();
				await hold.released;
				events.push({ kind: 'released', path: request.path, bodySha256 });
			}
			exchangeCount += 1;
			const exchange = `exchange-${exchangeCount}`;
			exchanges.set(exchange, {
				path: request.path,
				bodySha256,
				drop: takeFirstMatching(drops, request) ?? null,
				captures: captures
					.filter((capture) => capture.match(request))
					.map((capture) => capture.replies),
			});
			return { exchange };
		},
		afterForward({ exchange, status, reply }) {
			const opened = exchanges.get(exchange);
			if (opened === undefined) throw new Error(`Unknown link exchange ${exchange}`);
			exchanges.delete(exchange);
			const { path, bodySha256, drop } = opened;
			if (drop !== null) {
				if (status === 200) {
					events.push({
						kind: 'reply-dropped',
						path,
						bodySha256,
						status,
						replySha256: sha256(reply),
					});
					drop.dropped();
					return 'drop';
				}
				// A drop armed for a request central did not answer successfully stays armed.
				drops.unshift(drop);
			}
			events.push({ kind: 'forwarded', path, bodySha256, status });
			for (const replies of opened.captures)
				replies.push({
					status,
					body: parsedJson(reply),
					bodySha256: sha256(reply),
					bodyLength: reply.byteLength,
				});
			return 'deliver';
		},
	};
}

function forwardOverSocket(props: {
	readonly upstreamSocket: string;
	readonly method: string;
	readonly path: string;
	readonly headers: IncomingHttpHeaders;
	readonly body: Buffer;
}): Promise<{
	readonly status: number;
	readonly headers: IncomingHttpHeaders;
	readonly body: Buffer;
}> {
	return new Promise((resolveForward, rejectForward): void => {
		const outbound = httpRequest(
			{
				socketPath: props.upstreamSocket,
				method: props.method,
				path: props.path,
				headers: { ...props.headers, 'content-length': String(props.body.length) },
			},
			(reply: IncomingMessage): void => {
				const chunks: Buffer[] = [];
				reply.on('data', (chunk: Buffer) => chunks.push(chunk));
				reply.on('end', () =>
					resolveForward({
						status: reply.statusCode ?? 0,
						headers: reply.headers,
						body: Buffer.concat(chunks),
					}),
				);
				reply.on('error', rejectForward);
			},
		);
		outbound.on('error', rejectForward);
		outbound.end(props.body);
	});
}

/** The Node pairing's hop: its own 0600 socket in front of real Tokio central's link socket. */
export async function startLinkFaultProxy(upstreamSocket: string): Promise<LinkFaultProxy> {
	const directory = await mkdtemp('/tmp/2026-11-b2e-link-');
	await chmod(directory, 0o700);
	const socketPath = join(directory, 'link.sock');
	const control = createLinkFaultControl();
	const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse): void => {
		void (async (): Promise<void> => {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			const path = incoming.url ?? '/';
			const { exchange } = await control.beforeForward({ path, body });
			try {
				const reply = await forwardOverSocket({
					upstreamSocket,
					method: incoming.method ?? 'GET',
					path,
					headers: incoming.headers,
					body,
				});
				const verdict = control.afterForward({
					exchange,
					status: reply.status,
					reply: reply.body,
				});
				if (verdict === 'drop') {
					outgoing.destroy();
					return;
				}
				outgoing.writeHead(reply.status, reply.headers);
				outgoing.end(reply.body);
			} catch {
				outgoing.destroy();
			}
		})();
	});
	await new Promise<void>((resolveListen, rejectListen): void => {
		server.once('error', rejectListen);
		server.listen(socketPath, resolveListen);
	});
	await chmod(socketPath, 0o600);
	return {
		socketPath,
		events: control.events,
		holdNext: control.holdNext,
		dropReplyOfNext: control.dropReplyOfNext,
		captureReplies: control.captureReplies,
		async close(): Promise<void> {
			server.closeAllConnections();
			await new Promise<void>((resolveClose): void => {
				server.close((): void => resolveClose());
			});
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/** Hop-by-hop and framing headers the next hop sets for itself. */
const headersTheHopSets = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

/**
 * The workerd pairing's hop: sign-in's CENTRAL binding, in front of central's own bridge
 * gateway, which routes `/private/*` to central's link Worker and on to its CentralObject. The
 * request's path and bytes pass unchanged. A dropped reply throws, so the reply central sent
 * never reaches sign-in, as the socket proxy's destroyed connection does.
 */
export function forwardThroughLinkFault(props: {
	readonly control: LinkFaultControl;
	/** The bridge origin currently serving; an empty restart switches it. */
	readonly upstreamOrigin: () => string;
}): (request: Request) => Promise<Response> {
	return async (request) => {
		const url = new URL(request.url);
		const path = url.pathname + url.search;
		const body = new Uint8Array(await request.arrayBuffer());
		const { exchange } = await props.control.beforeForward({ path, body });
		const headers = new Headers();
		for (const [name, value] of request.headers)
			if (!headersTheHopSets.has(name.toLowerCase())) headers.append(name, value);
		const reply = await fetch(`${props.upstreamOrigin()}/private${path}`, {
			method: request.method,
			headers,
			redirect: 'manual',
			...(['GET', 'HEAD'].includes(request.method) ? {} : { body }),
		});
		const replyBody = new Uint8Array(await reply.arrayBuffer());
		const verdict = props.control.afterForward({
			exchange,
			status: reply.status,
			reply: replyBody,
		});
		if (verdict === 'drop') throw new Error("B2e link fault: central's reply was dropped");
		return new Response(replyBody, { status: reply.status, headers: reply.headers });
	};
}
