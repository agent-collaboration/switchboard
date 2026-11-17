import type { createSignInManagementBinding } from '@agent-collaboration/sign-in-core/better-auth';
import { z } from 'zod';

// The fixture transport preserves additional fields so the real management
// boundary, rather than this bridge, decides whether an operation is valid.
const ownerProofSchema = z.looseObject({ token: z.string(), organizationId: z.string() });
const operationSchema = ownerProofSchema.extend({ requestId: z.string() });
const workspaceOperationSchema = operationSchema.extend({ workspaceId: z.string() });
export const nodeManagementBridgeCallSchema = z.discriminatedUnion('method', [
	z.strictObject({ method: z.literal('humanCheckStatus') }),
	z.strictObject({ method: z.literal('isLiveOwner'), props: ownerProofSchema }),
	z.strictObject({
		method: z.literal('ownsAgentClient'),
		props: ownerProofSchema.extend({ clientId: z.string() }),
	}),
	z.strictObject({ method: z.literal('registerAndLink'), props: workspaceOperationSchema }),
	z.strictObject({
		method: z.literal('link'),
		props: workspaceOperationSchema.extend({ clientId: z.string() }),
	}),
	z.strictObject({
		method: z.literal('unlink'),
		props: workspaceOperationSchema.extend({ clientId: z.string() }),
	}),
	z.strictObject({
		method: z.literal('disable'),
		props: operationSchema.extend({ clientId: z.string() }),
	}),
]);
export type NodeManagementBridgeCall = z.infer<typeof nodeManagementBridgeCallSchema>;

/** Runs the real named binding in Worker request context, where Miniflare's
 * synchronous Node proxy cannot block the Node listener the bridge calls. */
export async function dispatchNamedManagementCall(
	binding: ReturnType<typeof createSignInManagementBinding>,
	call: NodeManagementBridgeCall,
): Promise<unknown> {
	switch (call.method) {
		case 'humanCheckStatus':
			return binding.humanCheckStatus();
		case 'isLiveOwner':
			return binding.isLiveOwner(call.props);
		case 'ownsAgentClient':
			return binding.ownsAgentClient(call.props);
		case 'registerAndLink':
			return binding.registerAndLink(call.props);
		case 'link':
			return binding.link(call.props);
		case 'unlink':
			return binding.unlink(call.props);
		case 'disable':
			return binding.disable(call.props);
		default: {
			const unhandled: never = call;
			throw new Error(`Unknown management call: ${String(unhandled)}`);
		}
	}
}

export const nodeHttpRequestIdentitySchema = z.strictObject({
	httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
	path: z
		.string()
		.startsWith('/')
		.max(512)
		.regex(/^[^?#]*$/u),
});
export type NodeHttpRequestIdentity = z.infer<typeof nodeHttpRequestIdentitySchema>;

export const nodeInvocationReceiptSchema = nodeHttpRequestIdentitySchema.extend({
	invocationId: z.uuidv7(),
	method: z.enum([
		'http',
		'invalid-management',
		'humanCheckStatus',
		'isLiveOwner',
		'ownsAgentClient',
		'registerAndLink',
		'link',
		'unlink',
		'disable',
	]),
	requestHash: z.string().length(64),
	responseHash: z.string().length(64),
	status: z.number().int(),
});
export type NodeInvocationReceipt = z.infer<typeof nodeInvocationReceiptSchema>;

const managementFailureSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('incomplete'), clientId: z.string() }),
	z.strictObject({
		kind: z.literal('refused'),
		reason: z.enum([
			'not-owner',
			'foreign-organization',
			'invalid-client',
			'resource-conflict',
			'operation-conflict',
			'human-check-not-implemented',
		]),
	}),
]);
const workspaceResultSchema = z.strictObject({
	clientId: z.string(),
	workspaceId: z.string(),
	resource: z.string(),
});
export const registeredBridgeResultSchema = z.union([
	workspaceResultSchema.extend({ kind: z.literal('registered'), clientSecret: z.string() }),
	managementFailureSchema,
]);
export const linkedBridgeResultSchema = z.union([
	workspaceResultSchema.extend({ kind: z.literal('linked') }),
	managementFailureSchema,
]);
export const unlinkedBridgeResultSchema = z.union([
	workspaceResultSchema.extend({ kind: z.literal('unlinked') }),
	managementFailureSchema,
]);
export const disabledBridgeResultSchema = z.union([
	z.strictObject({ kind: z.literal('disabled'), clientId: z.string() }),
	managementFailureSchema,
]);
export const humanCheckBridgeResultSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('ready'), level: z.literal('remembered-login') }),
	z.strictObject({
		kind: z.literal('not-implemented'),
		level: z.enum(['fresh-verified-uv', 'exact-operation-binding']),
	}),
]);

export async function nodeInvocationDigest(text: string): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
