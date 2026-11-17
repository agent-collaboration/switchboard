import type { Writable } from 'node:stream';

import type { SignInClock, SignInObservation } from '@agent-collaboration/sign-in-core';
import { getJsonLinesFormatter, type LogRecord } from '@logtape/logtape';
import { getOpenTelemetrySink } from '@logtape/otel';

export type NodeSignInLogEvent =
	| SignInObservation
	| { readonly kind: 'listener-started' }
	| { readonly kind: 'listener-stopped' }
	| { readonly kind: 'request-completed'; readonly status: number }
	| { readonly kind: 'request-failed'; readonly reason: 'transport-error' };

export interface NodeSignInLogging {
	readonly log: (event: NodeSignInLogEvent) => void;
	readonly close: () => Promise<void>;
}

/** Sinks belong to this host instance; no process-wide LogTape configuration changes. */
export function createNodeSignInLogging(props: {
	readonly clock: SignInClock;
	readonly output: Writable;
	readonly endpoint: string | undefined;
}): NodeSignInLogging {
	const formatter = getJsonLinesFormatter({
		categorySeparator: '.',
		message: 'rendered',
		properties: 'nest:properties',
	});
	const sink =
		props.endpoint === undefined
			? undefined
			: getOpenTelemetrySink({
					serviceName: 'sign-in-host-node',
					diagnostics: false,
					exceptionAttributes: false,
					otlpExporterConfig: { url: `${props.endpoint.replace(/\/$/u, '')}/v1/logs` },
				});
	let closed = false;
	return {
		log(event): void {
			if (closed) return;
			const record: LogRecord = {
				category: ['agent-collaboration', 'sign-in-host-node'],
				level: event.kind === 'request-failed' ? 'error' : 'info',
				timestamp: props.clock.now(),
				message: [event.kind],
				rawMessage: event.kind,
				properties: { ...event },
			};
			// Telemetry never determines an HTTP answer, including synchronous sink failures.
			try {
				props.output.write(formatter(record));
			} catch {
				/* Output is best effort. */
			}
			try {
				sink?.(record);
			} catch {
				/* Export is best effort. */
			}
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			try {
				await sink?.[Symbol.asyncDispose]();
			} catch {
				/* Shutdown preserves host teardown. */
			}
		},
	};
}
