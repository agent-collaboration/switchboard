import { z } from 'zod';

import type { PreparedDriverCall } from '#sign-in-test-support/test-fixtures/database-fault-identity';

export const fleetSnapshotProbeHeader = 'x-auth-proof-fleet-snapshot';
/** What happens once the coherent person-fleet read has returned, before the token is signed. */
export const fleetSnapshotProbeSchema = z.discriminatedUnion('mode', [
	z.strictObject({
		mode: z.literal('advance'),
		milliseconds: z.number().int().min(1).max(3_600_000),
	}),
	z.strictObject({ mode: z.literal('barrier'), key: z.uuidv7() }),
]);
export type FleetSnapshotProbe = z.infer<typeof fleetSnapshotProbeSchema>;
export const fleetSnapshotHoldPoint = 'after-person-fleet-snapshot-read';

export function readFleetSnapshotProbe(request: Request): FleetSnapshotProbe | null {
	if (new URL(request.url).pathname !== '/api/auth/oauth2/token' || request.method !== 'POST')
		return null;
	const header = request.headers.get(fleetSnapshotProbeHeader);
	return header === null ? null : fleetSnapshotProbeSchema.parse(JSON.parse(header));
}

/** The production coherent read is the one SELECT joining the session to both fences. */
export function isPersonFleetSnapshotRead(call: PreparedDriverCall): boolean {
	return (
		/^select\b/iu.test(call.query) &&
		call.query.includes('from "session"') &&
		call.query.includes('"person_organization_authorization_revisions"') &&
		call.query.includes('"organization_authorization_revisions"')
	);
}
