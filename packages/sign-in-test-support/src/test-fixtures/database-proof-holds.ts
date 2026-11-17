import { callAuthProofBarrier } from '#sign-in-test-support/test-fixtures/auth-proof-barrier-client';
import type { PreparedDriverCall } from '#sign-in-test-support/test-fixtures/database-fault-identity';
import {
	fleetSnapshotHoldPoint,
	isPersonFleetSnapshotRead,
	type FleetSnapshotProbe,
} from '#sign-in-test-support/test-fixtures/fleet-snapshot-proof';
import { requireSignedAgentProjection } from '#sign-in-test-support/test-fixtures/native-signature-observer';
import {
	personSessionReadKind,
	type PersonConfirmationProbe,
} from '#sign-in-test-support/test-fixtures/person-confirmation-proof';

export type DatabaseReadHold =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'token';
			readonly bindings: AuthWorkerEnv;
			readonly clientId: string;
	  }
	| { readonly kind: 'management'; readonly bindings: AuthWorkerEnv; readonly requestId: string }
	| {
			readonly kind: 'fleet-snapshot';
			readonly bindings: AuthWorkerEnv;
			readonly probe: FleetSnapshotProbe;
			readonly clock: {
				readonly now: () => number;
				readonly advance: (milliseconds: number) => void;
			};
	  }
	| {
			readonly kind: 'confirmation';
			readonly bindings: AuthWorkerEnv;
			readonly probe: PersonConfirmationProbe;
			readonly clock: {
				readonly now: () => number;
				readonly advance: (milliseconds: number) => void;
			};
	  };

function registrationRead(call: PreparedDriverCall, clientId: string): boolean {
	const query = call.query
		.replaceAll(/"oauthClient"\./gu, '')
		.replaceAll(/\s+/gu, ' ')
		.trim();
	return (
		query.startsWith(
			'select "clientId", "metadata", "grantTypes", "clientCredentialsScopes", "tokenEndpointAuthMethod", "disabled" from "oauthClient"',
		) && call.parameters.includes(clientId)
	);
}
function ownerRead(call: PreparedDriverCall): boolean {
	return (
		/^select\b/iu.test(call.query) &&
		call.query.includes('from "member"') &&
		call.parameters.includes('owner')
	);
}

/** Read counters describe the named production fences, not write-fault ordinals.
 * Every observer is owned by one incoming HTTP/RPC invocation. */
export function createDatabaseReadHold(hold: DatabaseReadHold): {
	readonly beforeRead: (call: PreparedDriverCall) => Promise<void>;
	readonly afterRead: (call: PreparedDriverCall) => Promise<void>;
} {
	let registrationReads = 0;
	let ownerReads = 0;
	let confirmation:
		| { readonly kind: 'pending' }
		| { readonly kind: 'provider-read' }
		| { readonly kind: 'first-read'; readonly checkedAt: number }
		| { readonly kind: 'observed' } = { kind: 'pending' };
	return {
		async beforeRead(call): Promise<void> {
			if (hold.kind === 'confirmation') {
				const kind = personSessionReadKind(call, hold.probe.sessionId);
				if (kind === 'provider' && confirmation.kind === 'pending') {
					hold.clock.advance(hold.clock.now() + hold.probe.advanceBeforeReadMilliseconds);
					confirmation = { kind: 'provider-read' };
				} else if (kind === 'confirmation' && confirmation.kind !== 'observed') {
					confirmation = { kind: 'first-read', checkedAt: hold.clock.now() };
				}
				return;
			}
			if (hold.kind === 'token' && registrationRead(call, hold.clientId)) {
				registrationReads += 1;
				if (registrationReads === 2) {
					await callAuthProofBarrier({
						bindings: hold.bindings,
						channel: 'hold',
						operation: 'arrive',
						key: hold.clientId,
						event: requireSignedAgentProjection(hold.clientId),
					});
				}
			} else if (hold.kind === 'management' && ownerRead(call)) {
				ownerReads += 1;
				if (ownerReads === 3)
					await callAuthProofBarrier({
						bindings: hold.bindings,
						channel: 'management-hold',
						operation: 'arrive',
						key: hold.requestId,
						event: { point: 'before-provider-owner-read', requestId: hold.requestId },
					});
			}
		},
		async afterRead(call): Promise<void> {
			if (hold.kind === 'fleet-snapshot') {
				if (!isPersonFleetSnapshotRead(call)) return;
				if (hold.probe.mode === 'advance')
					hold.clock.advance(hold.clock.now() + hold.probe.milliseconds);
				else
					await callAuthProofBarrier({
						bindings: hold.bindings,
						channel: 'hold',
						operation: 'arrive',
						key: hold.probe.key,
						event: { point: fleetSnapshotHoldPoint },
					});
				return;
			}
			if (
				hold.kind !== 'confirmation' ||
				confirmation.kind !== 'first-read' ||
				personSessionReadKind(call, hold.probe.sessionId) !== 'confirmation'
			)
				return;
			const checkedAt = confirmation.checkedAt;
			confirmation = { kind: 'observed' };
			await callAuthProofBarrier({
				bindings: hold.bindings,
				channel: 'confirmation-hold',
				operation: 'arrive',
				key: hold.probe.sessionId,
				event: { point: 'first-person-session-read', sessionId: hold.probe.sessionId, checkedAt },
			});
		},
	};
}
