import { z } from 'zod';

import { WorkspaceAuthority } from '#worker-host/durable-workspace-authority/workspace-authority';

export { WorkspaceAuthority };

const clientFields = { workspaceId: z.uuidv7(), clientId: z.uuidv7() };
const operationSchema = z.enum(['unlink', 'disable']);
const controlSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('read-membership'), ...clientFields }),
	z.strictObject({ kind: z.literal('read-removal'), ...clientFields }),
	z.strictObject({ kind: z.literal('admit'), ...clientFields, persona: z.string().min(1) }),
	z.strictObject({
		kind: z.literal('begin'),
		...clientFields,
		requestId: z.uuidv7(),
		intent: z.strictObject({
			operation: operationSchema,
			replacesPendingRequestId: z.uuidv7().optional(),
		}),
	}),
	z.strictObject({
		kind: z.literal('complete'),
		...clientFields,
		requestId: z.uuidv7(),
		operation: operationSchema,
	}),
]);

// Only test controls are added; all membership decisions and transactions use the real DO.
export default {
	async fetch(
		request: Request,
		bindings: Readonly<Pick<ToolPortalWorkerEnv, 'WORKSPACES'>>,
	): Promise<Response> {
		const input = controlSchema.parse(await request.json());
		const object = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(input.workspaceId));
		try {
			switch (input.kind) {
				case 'read-membership':
					return Response.json(await object.readMembership(input.clientId));
				case 'read-removal':
					return Response.json(await object.readAgentRemoval(input.clientId));
				case 'admit':
					await object.setMembership(input.clientId, input.persona);
					return Response.json(null);
				case 'begin':
					return Response.json(
						await object.beginAgentRemoval(input.clientId, input.requestId, {
							operation: input.intent.operation,
							...(input.intent.replacesPendingRequestId === undefined
								? {}
								: { replacesPendingRequestId: input.intent.replacesPendingRequestId }),
						}),
					);
				case 'complete':
					await object.completeAgentRemoval(input.clientId, input.requestId, input.operation);
					return Response.json(null);
				default:
					input satisfies never;
					throw new Error('Unsupported removal proof control');
			}
		} catch (error: unknown) {
			// Preserve RPC errors for the model; unknown errors cannot count as a valid conflict.
			if (!(error instanceof Error)) throw error;
			return Response.json({ message: error.message }, { status: 409 });
		}
	},
};
