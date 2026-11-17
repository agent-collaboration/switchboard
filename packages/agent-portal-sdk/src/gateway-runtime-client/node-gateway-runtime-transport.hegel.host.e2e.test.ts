import { mkdtemp, rmdir } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

import * as hegel from '@hegeldev/hegel';
import { expect, it } from 'vitest';

import {
	GatewayRuntimeFrameDecoder,
	type GatewayRuntimeJsonRpcMessage,
} from './gateway-runtime-protocol.js';
import type { GatewayRuntimeConnection } from './index.js';
import { createNodeGatewayRuntimeTransportFactory } from './node-gateway-runtime-transport.js';

type RequestOutcome =
	| { readonly kind: 'resolved'; readonly value: unknown }
	| { readonly kind: 'rejected'; readonly error: unknown };
interface PendingCall {
	readonly id: number;
	readonly controller: AbortController;
	readonly outcome: Promise<RequestOutcome>;
}
interface SocketScenario {
	readonly connection: GatewayRuntimeConnection;
	readonly socket: net.Socket;
	readonly messages: MessageQueue;
	readonly pending: PendingCall[];
	readonly cancelled: number[];
	closed: boolean;
}

class MessageQueue {
	readonly #messages: GatewayRuntimeJsonRpcMessage[] = [];
	readonly #waiters: ((message: GatewayRuntimeJsonRpcMessage) => void)[] = [];
	readonly #decoder = new GatewayRuntimeFrameDecoder();
	constructor(socket: net.Socket) {
		socket.on('data', (chunk: Buffer): void => {
			for (const message of this.#decoder.push(chunk)) {
				const waiter = this.#waiters.shift();
				if (waiter === undefined) this.#messages.push(message);
				else waiter(message);
			}
		});
	}
	next(): Promise<GatewayRuntimeJsonRpcMessage> {
		const message = this.#messages.shift();
		if (message !== undefined) return Promise.resolve(message);
		return new Promise((resolve): void => {
			this.#waiters.push(resolve);
		});
	}
}

function observeRequest(request: Promise<unknown>): Promise<RequestOutcome> {
	return request.then(
		(value): RequestOutcome => ({ kind: 'resolved', value }),
		(error: unknown): RequestOutcome => ({ kind: 'rejected', error }),
	);
}

async function startCall(scenario: SocketScenario): Promise<PendingCall> {
	const controller = new AbortController();
	const outcome = observeRequest(
		scenario.connection.request('probe', {}, { signal: controller.signal }),
	);
	const received = await Promise.race([
		scenario.messages.next().then((message) => ({ kind: 'message', message }) as const),
		outcome.then((result) => ({ kind: 'outcome', result }) as const),
	]);
	expect(received.kind).toBe('message');
	if (received.kind !== 'message')
		throw new Error(`Request rejected before arriving: ${JSON.stringify(received.result)}`);
	const id = received.message['id'];
	expect(typeof id).toBe('number');
	if (typeof id !== 'number') throw new Error('Expected numeric request id');
	return { id, controller, outcome };
}

function reply(socket: net.Socket, id: number): void {
	const body = JSON.stringify({ jsonrpc: '2.0', id, result: { id } });
	socket.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

async function abortCall(scenario: SocketScenario, call: PendingCall): Promise<void> {
	call.controller.abort();
	expect(await call.outcome).toMatchObject({
		kind: 'rejected',
		error: { code: 'request-aborted' },
	});
	const notification = await scenario.messages.next();
	expect(notification).toMatchObject({
		method: 'notifications/cancelled',
		params: { requestId: call.id },
	});
	scenario.cancelled.push(call.id);
}

async function releasedSlotBeforeLateReply(scenario: SocketScenario): Promise<void> {
	const cancelledCall = await startCall(scenario);
	await abortCall(scenario, cancelledCall);
	// Capacity is one. The second request must arrive while the first reply is held.
	const nextCall = await startCall(scenario);
	reply(scenario.socket, cancelledCall.id);
	reply(scenario.socket, nextCall.id);
	expect(await nextCall.outcome).toEqual({ kind: 'resolved', value: { id: nextCall.id } });
	scenario.cancelled.length = 0;
}

const transportMachine: hegel.stateful.StateMachine<SocketScenario> = {
	rules: {
		request: async (tc, scenario): Promise<void> => {
			tc.note(`request closed=${scenario.closed} pending=${scenario.pending.length}`);
			if (scenario.closed) {
				expect(await observeRequest(scenario.connection.request('probe', {}))).toMatchObject({
					kind: 'rejected',
				});
			} else if (scenario.pending.length === 0) scenario.pending.push(await startCall(scenario));
		},
		abort: async (tc, scenario): Promise<void> => {
			const call = scenario.cancelled.length === 0 ? scenario.pending.shift() : undefined;
			tc.note(`abort id=${call?.id}`);
			if (call !== undefined) await abortCall(scenario, call);
		},
		lateReply: async (tc, scenario): Promise<void> => {
			const id = scenario.cancelled.shift();
			tc.note(`late reply id=${id}`);
			if (id !== undefined && !scenario.closed) {
				reply(scenario.socket, id);
				// The following response is a barrier proving the preceding late reply was read.
				const call = scenario.pending.shift() ?? (await startCall(scenario));
				reply(scenario.socket, call.id);
				expect(await call.outcome).toEqual({ kind: 'resolved', value: { id: call.id } });
			}
		},
		respond: async (tc, scenario): Promise<void> => {
			const call = scenario.pending.shift();
			tc.note(`respond id=${call?.id}`);
			if (call !== undefined) {
				reply(scenario.socket, call.id);
				expect(await call.outcome).toEqual({ kind: 'resolved', value: { id: call.id } });
			}
		},
		close: async (tc, scenario): Promise<void> => {
			tc.note(`close pending=${scenario.pending.length}`);
			if (!scenario.closed && scenario.pending.length === 0)
				scenario.pending.push(await startCall(scenario));
			await scenario.connection.close();
			scenario.closed = true;
			const call = scenario.pending.shift();
			if (call !== undefined)
				expect(await call.outcome).toMatchObject({
					kind: 'rejected',
					error: { code: 'connection-closed' },
				});
		},
	},
	invariants: {
		capacityAndClosedState: {
			alwaysCheck: true,
			check: async (_tc, scenario): Promise<void> => {
				expect(scenario.pending.length).toBeLessThanOrEqual(1);
				if (scenario.closed)
					expect(await observeRequest(scenario.connection.request('probe', {}))).toMatchObject({
						kind: 'rejected',
						error: { code: 'connection-closed' },
					});
			},
		},
	},
};

it('M5 models request, abort, late reply and close over a Unix socket', async () => {
	await hegel.testAsync(
		async (tc): Promise<void> => {
			const root = await mkdtemp('/tmp/2026-11-f2-rpc-');
			const socketPath = join(root, 'gateway.sock');
			let serverSocket: net.Socket | undefined;
			const server = net.createServer();
			const accepted = new Promise<net.Socket>((resolve): void => {
				server.once('connection', resolve);
			});
			try {
				await new Promise<void>((resolve, reject): void => {
					server.once('error', reject);
					server.listen(socketPath, resolve);
				});
				const connection = await createNodeGatewayRuntimeTransportFactory({
					maxPendingRequests: 1,
				}).connect({ socketPath, signal: new AbortController().signal });
				const socket = await accepted;
				serverSocket = socket;
				const scenario: SocketScenario = {
					connection,
					socket,
					messages: new MessageQueue(socket),
					pending: [],
					cancelled: [],
					closed: false,
				};
				try {
					tc.note('capacity prelude: one held cancelled reply');
					await releasedSlotBeforeLateReply(scenario);
					await hegel.stateful.runAsync(tc, transportMachine, scenario, { stepCount: 50 });
					if (!scenario.closed) await transportMachine.rules['close']?.(tc, scenario);
				} finally {
					await connection.close();
				}
			} finally {
				serverSocket?.destroy();
				if (server.listening) {
					await new Promise<void>((resolve, reject): void => {
						server.close((error): void => {
							if (error) reject(error);
							else resolve();
						});
					});
				}
				await rmdir(root);
			}
		},
		{ testCases: 100, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
});
