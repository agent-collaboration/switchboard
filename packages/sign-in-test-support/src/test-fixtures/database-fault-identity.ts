import { z } from 'zod';

export const databaseFaultSchema = z.strictObject({
	operation: z.enum(['insert', 'update', 'delete', 'select']),
	table: z.enum([
		'user',
		'session',
		'account',
		'organization',
		'member',
		'invitation',
		'twoFactor',
		'passkey',
		'verification',
		'sign_in_audit',
		'oauthClient',
		'oauthClientResource',
	]),
	key: z.string().min(1),
	additionalKeys: z.array(z.string()).default([]),
	phase: z.enum(['intent', 'outcome']).optional(),
	changeKind: z.string().optional(),
	auditKind: z.string().optional(),
	column: z.enum(['disabled', 'clientSecret', 'secondFactorSetAt']).optional(),
});
export type DatabaseFault = z.infer<typeof databaseFaultSchema>;

export interface PreparedDriverCall {
	readonly query: string;
	readonly parameters: readonly unknown[];
}
export function matchesDatabaseFault(call: PreparedDriverCall, fault: DatabaseFault): boolean {
	const table = /\b(?:insert\s+into|update|delete\s+from|from)\s+["`]?([\w]+)["`]?/iu.exec(
		call.query,
	)?.[1];
	const operation = /^\s*(insert|update|delete|select)\b/iu.exec(call.query)?.[1]?.toLowerCase();
	if (table !== fault.table || operation !== fault.operation) return false;
	function contains(value: string): boolean {
		return call.parameters.includes(value) || call.query.includes(`'${value}'`);
	}
	return (
		[fault.key, ...fault.additionalKeys].some(contains) &&
		(fault.phase === undefined || contains(fault.phase)) &&
		(fault.changeKind === undefined || contains(fault.changeKind)) &&
		(fault.auditKind === undefined || contains(fault.auditKind)) &&
		(fault.column === undefined || call.query.includes(`"${fault.column}" =`))
	);
}
