import { workspaceResourceIdentifier } from '@agent-collaboration/tool-access/contracts';

export const organizationOne = '11111111-1111-7111-8111-111111111111';
export const organizationTwo = '22222222-2222-7222-8222-222222222222';
export const registrationRequestId = 'b015079b-19b6-7aa2-9b82-1298efcb2f79';
export const registeredClientId = `agent-${organizationOne}-${registrationRequestId}`;
export const workspaceOne = '33333333-3333-7333-8333-333333333333';
export const workspaceTwo = '44444444-4444-7444-8444-444444444444';
export const workspaceThree = '55555555-5555-7555-8555-555555555555';
export const toolPortalOrigin = 'https://portal-test.invalid';
export function workspaceAudience(workspaceId: string): string {
	return workspaceResourceIdentifier({ toolPortalOrigin, workspaceId });
}
export const agentAudience = workspaceAudience(workspaceOne);
export const managementAudience = 'https://portal-test.invalid/management';

export function textBindings(
	values: Readonly<Record<string, string>>,
): Record<string, { readonly type: 'text'; readonly value: string }> {
	return Object.fromEntries(
		Object.entries(values).map(([name, value]) => [name, { type: 'text', value }]),
	);
}

export function workspaceConfigurations(upstream: string): unknown {
	function configuration(name: string, organizationId: string, credential: string): unknown {
		return {
			organizationId,
			workspaceName: name,
			approvalKeyBinding: 'APPROVAL_KEY',
			mcp: {
				schemaVersion: 1,
				providers: {
					fixture: {
						kind: 'mcp',
						namespace: 'proof-upstream',
						transport: {
							kind: 'streamable-http',
							url: upstream,
							headers: { authorization: { source: 'environment', name: credential } },
						},
					},
				},
			},
			portal: {
				schemaVersion: 1,
				agents: { [registeredClientId]: {} },
				profiles: {
					operator: {
						namespaces: {
							'proof-upstream': {
								tools: { allow: '*' },
								calls: {
									withoutApproval: { allow: ['record_effect'] },
									requiresApproval: { allow: [] },
								},
							},
						},
					},
				},
			},
		};
	}
	return {
		[workspaceOne]: configuration('proof-one', organizationOne, 'ONE_CREDENTIAL'),
		[workspaceTwo]: configuration('proof-two', organizationOne, 'TWO_CREDENTIAL'),
		[workspaceThree]: configuration('proof-three', organizationTwo, 'THREE_CREDENTIAL'),
	};
}
