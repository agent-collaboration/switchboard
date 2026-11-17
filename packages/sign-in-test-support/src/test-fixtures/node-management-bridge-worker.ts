import type { createSignInManagementBinding } from '@agent-collaboration/sign-in-core/better-auth';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';

import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	dispatchNamedManagementCall,
	nodeManagementBridgeCallSchema,
	disabledBridgeResultSchema,
	humanCheckBridgeResultSchema,
	linkedBridgeResultSchema,
	nodeInvocationDigest,
	registeredBridgeResultSchema,
	unlinkedBridgeResultSchema,
	type NodeInvocationReceipt,
	type NodeManagementBridgeCall,
} from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';

interface NodeBridgeBindings {
	readonly NODE_SIGN_IN_ORIGIN: string;
	readonly SELF_MANAGEMENT: ManagementBinding;
}
type ManagementBinding = ReturnType<typeof createSignInManagementBinding>;
const initiated: {
	readonly invocationId: string;
	readonly method: string;
	readonly requestHash: string;
}[] = [];
const completed: NodeInvocationReceipt[] = [];

/** Sensitivity target: replacing this forwarder with a Worker-store answer must
 * fail the independent initiated-versus-Node-receipt assertion at harness close. */
export async function forwardNodeBridgeCall(props: {
	readonly origin: string;
	readonly invocationId: string;
	readonly body: string;
}): Promise<Response> {
	return fetch(new URL('/__auth-proof/node-management', props.origin), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-auth-proof-invocation': props.invocationId,
			'x-auth-proof-client-address': '127.0.0.1',
		},
		body: props.body,
	});
}

async function invokeNodeManagement<TSchema extends z.ZodType>(props: {
	readonly bindings: NodeBridgeBindings;
	readonly call: NodeManagementBridgeCall;
	readonly resultSchema: TSchema;
}): Promise<z.output<TSchema>> {
	const invocationId = controlledSignInIds.nextId();
	const body = JSON.stringify(props.call);
	const requestHash = await nodeInvocationDigest(body);
	initiated.push({ invocationId, method: props.call.method, requestHash });
	const response = await forwardNodeBridgeCall({
		origin: props.bindings.NODE_SIGN_IN_ORIGIN,
		invocationId,
		body,
	});
	const responseBody = await response.text();
	completed.push({
		httpMethod: 'POST',
		path: '/__auth-proof/node-management',
		invocationId,
		method: props.call.method,
		requestHash,
		responseHash: await nodeInvocationDigest(responseBody),
		status: response.status,
	});
	if (response.headers.get('x-auth-proof-invocation') !== invocationId || !response.ok)
		throw new Error('Node bridge invocation did not complete at the selected Node host');
	return props.resultSchema.parse(JSON.parse(responseBody));
}

export class NodeAgentClientManagement extends WorkerEntrypoint<NodeBridgeBindings> {
	humanCheckStatus(): ReturnType<ManagementBinding['humanCheckStatus']> {
		return invokeNodeManagement({
			bindings: this.env,
			call: { method: 'humanCheckStatus' },
			resultSchema: humanCheckBridgeResultSchema,
		});
	}
	isLiveOwner(
		props: Parameters<ManagementBinding['isLiveOwner']>[0],
	): ReturnType<ManagementBinding['isLiveOwner']> {
		return invokeNodeManagement({
			bindings: this.env,
			call: { method: 'isLiveOwner', props },
			resultSchema: z.boolean(),
		});
	}
	ownsAgentClient(
		props: Parameters<ManagementBinding['ownsAgentClient']>[0],
	): ReturnType<ManagementBinding['ownsAgentClient']> {
		return invokeNodeManagement({
			bindings: this.env,
			call: { method: 'ownsAgentClient', props },
			resultSchema: z.boolean(),
		});
	}
	registerAndLink(
		props: Parameters<ManagementBinding['registerAndLink']>[0],
	): ReturnType<ManagementBinding['registerAndLink']> {
		return invokeNodeManagement({
			bindings: this.env,
			call: { method: 'registerAndLink', props },
			resultSchema: registeredBridgeResultSchema,
		});
	}
	link(props: Parameters<ManagementBinding['link']>[0]): ReturnType<ManagementBinding['link']> {
		return invokeNodeManagement({
			bindings: this.env,
			call: { method: 'link', props },
			resultSchema: linkedBridgeResultSchema,
		});
	}
	unlink(
		props: Parameters<ManagementBinding['unlink']>[0],
	): ReturnType<ManagementBinding['unlink']> {
		return invokeNodeManagement({
			bindings: this.env,
			call: { method: 'unlink', props },
			resultSchema: unlinkedBridgeResultSchema,
		});
	}
	disable(
		props: Parameters<ManagementBinding['disable']>[0],
	): ReturnType<ManagementBinding['disable']> {
		return invokeNodeManagement({
			bindings: this.env,
			call: { method: 'disable', props },
			resultSchema: disabledBridgeResultSchema,
		});
	}
}

export default {
	async fetch(request: Request, bindings: NodeBridgeBindings): Promise<Response> {
		if (new URL(request.url).pathname === '/__auth-proof/call-named-management') {
			const call = nodeManagementBridgeCallSchema.parse(await request.json());
			return Response.json(await dispatchNamedManagementCall(bindings.SELF_MANAGEMENT, call));
		}
		return Response.json({ initiated, completed });
	},
};
