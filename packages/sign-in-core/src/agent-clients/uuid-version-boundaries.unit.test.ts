import { expect, it } from 'vitest';

import {
	agentRegistrationMetadataSchema,
	workspaceAgentChangeSchema,
} from '#sign-in-core/agent-clients/agent-registration';
import { signInConfigurationSchema } from '#sign-in-core/contracts/deployment-configuration';

const v7 = '11111111-1111-7111-8111-111111111111';
const v4 = '11111111-1111-4111-8111-111111111111';

it('accepts v7 changes and rejects a v4 at each sign-in operation UUID boundary', () => {
	const change = { requestId: v7, organizationId: v7, workspaceId: v7 };
	expect(workspaceAgentChangeSchema.safeParse(change).success).toBe(true);
	for (const field of ['requestId', 'organizationId', 'workspaceId'])
		expect(workspaceAgentChangeSchema.safeParse({ ...change, [field]: v4 }).success).toBe(false);
	expect(
		agentRegistrationMetadataSchema.safeParse({ kind: 'agent', organizationId: v4 }).success,
	).toBe(false);
	expect(signInConfigurationSchema.shape.organizationIds.safeParse([v4]).success).toBe(false);
});
