import type { createSignInManagementBinding } from '@agent-collaboration/sign-in-core/better-auth';
import type { Miniflare } from 'miniflare';
import { z } from 'zod';

import {
	disabledBridgeResultSchema,
	humanCheckBridgeResultSchema,
	linkedBridgeResultSchema,
	registeredBridgeResultSchema,
	unlinkedBridgeResultSchema,
	type NodeManagementBridgeCall,
} from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';

type ManagementBinding = ReturnType<typeof createSignInManagementBinding>;
interface ManagementCallResponse {
	readonly ok: boolean;
	readonly json: () => Promise<unknown>;
}

export async function signInManagementForHost(
	runtime: Miniflare,
	host: 'cloudflare' | 'node',
): Promise<ManagementBinding> {
	if (host === 'cloudflare')
		return (await runtime.getBindings<{ readonly SIGN_IN: ManagementBinding }>('gateway-one'))
			.SIGN_IN;
	return createAsyncNodeManagementCaller(async (call) =>
		(await runtime.getWorker('node-management-bridge')).fetch(
			'https://bridge-proof.invalid/__auth-proof/call-named-management',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(call),
			},
		),
	);
}

/** Fetch is Miniflare's asynchronous entry. The Worker endpoint then invokes
 * its real service binding, preserving the named-RPC behavior under test. */
export function createAsyncNodeManagementCaller(
	fetchCall: (call: NodeManagementBridgeCall) => Promise<ManagementCallResponse>,
): ManagementBinding {
	async function invoke<TSchema extends z.ZodType>(
		call: NodeManagementBridgeCall,
		schema: TSchema,
	): Promise<z.output<TSchema>> {
		const response = await fetchCall(call);
		if (!response.ok) throw new Error('Asynchronous named management invocation failed');
		return schema.parse(await response.json());
	}
	return {
		humanCheckStatus: () => invoke({ method: 'humanCheckStatus' }, humanCheckBridgeResultSchema),
		isLiveOwner: (props) => invoke({ method: 'isLiveOwner', props }, z.boolean()),
		ownsAgentClient: (props) => invoke({ method: 'ownsAgentClient', props }, z.boolean()),
		registerAndLink: (props) =>
			invoke({ method: 'registerAndLink', props }, registeredBridgeResultSchema),
		link: (props) => invoke({ method: 'link', props }, linkedBridgeResultSchema),
		unlink: (props) => invoke({ method: 'unlink', props }, unlinkedBridgeResultSchema),
		disable: (props) => invoke({ method: 'disable', props }, disabledBridgeResultSchema),
	};
}
