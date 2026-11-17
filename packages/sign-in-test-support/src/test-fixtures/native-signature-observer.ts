import { AsyncLocalStorage } from 'node:async_hooks';

import { z } from 'zod';

export interface SignedAgentProjection {
	readonly signed: true;
	readonly clientId: string;
	readonly organizationId: string | null;
	readonly workspaceId: string | null;
}
interface SigningInvocation {
	readonly clientId: string;
	projection: SignedAgentProjection | null;
}
const invocations = new AsyncLocalStorage<SigningInvocation>();
const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
const claimsSchema = z.object({
	client_id: z.string(),
	organization_id: z.string().optional(),
	workspace_id: z.string().optional(),
});

function decodeSegment(segment: string): unknown {
	const binary = atob(segment.replaceAll('-', '+').replaceAll('_', '/'));
	return JSON.parse(
		new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))),
	);
}

function projectSigningInput(data: BufferSource, clientId: string): SignedAgentProjection | null {
	try {
		const [header, payload, extra] = new TextDecoder().decode(data).split('.');
		if (header === undefined || payload === undefined || extra !== undefined) return null;
		if (!z.object({ typ: z.literal('at+jwt') }).safeParse(decodeSegment(header)).success)
			return null;
		const claims = claimsSchema.safeParse(decodeSegment(payload));
		if (!claims.success || claims.data.client_id !== clientId) return null;
		return {
			signed: true,
			clientId,
			organizationId: claims.data.organization_id ?? null,
			workspaceId: claims.data.workspace_id ?? null,
		};
	} catch {
		return null;
	}
}

// Test artifact only. Preserve the native call, its arguments and its exact result.
// No key, signature or JWS input is retained; only the bounded projection is stored
// after successful native completion, and only in the armed invocation's scope.
crypto.subtle.sign = async (
	...parameters: Parameters<SubtleCrypto['sign']>
): Promise<ArrayBuffer> => {
	const signature = await nativeSign(...parameters);
	const invocation = invocations.getStore();
	if (invocation !== undefined) {
		const projection = projectSigningInput(parameters[2], invocation.clientId);
		if (projection !== null) invocation.projection = projection;
	}
	return signature;
};

export function withNativeSigningObservation<TValue>(
	clientId: string,
	operation: () => Promise<TValue>,
): Promise<TValue> {
	return invocations.run({ clientId, projection: null }, operation);
}

export function requireSignedAgentProjection(clientId: string): SignedAgentProjection {
	const invocation = invocations.getStore();
	if (invocation?.clientId !== clientId || invocation.projection === null)
		throw new Error('No completed native signing observation for this invocation');
	return invocation.projection;
}
