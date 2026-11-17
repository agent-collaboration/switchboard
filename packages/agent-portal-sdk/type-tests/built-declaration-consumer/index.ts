import {
	PortalCallResultSchema,
	type PortalCallResult,
} from '@agent-collaboration/agent-portal-sdk';
import {
	PortalAdapterEnvelopeSchema,
	type PortalAdapterEnvelope,
} from '@agent-collaboration/agent-portal-sdk/adapter-boundary';
import {
	ApprovalRequiredResultSchema,
	type ApprovalRequiredResult,
} from '@agent-collaboration/agent-portal-sdk/approval-surface';
import {
	PortalArtifactReadRequestSchema,
	type PortalArtifactReadRequest,
} from '@agent-collaboration/agent-portal-sdk/artifact-surface';
import {
	CapabilityDescriptorSchema,
	type CapabilityDescriptor,
} from '@agent-collaboration/agent-portal-sdk/capability-description-surface';
import {
	GatewayRuntimeFrameworkIdentitySchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
	ManagedAgentProjectionSchema,
	type GatewayRuntimeFrameworkIdentity,
	type GatewayRuntimeTrustedInvocationPrincipal,
	type ManagedAgentProjection,
} from '@agent-collaboration/agent-portal-sdk/contracts';
import {
	DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
	type GatewayRuntimeClientOptions,
} from '@agent-collaboration/agent-portal-sdk/gateway-runtime-client';
import {
	PORTABLE_CONTRACT_ADAPTERS,
	type PortableContractAdapter,
} from '@agent-collaboration/agent-portal-sdk/portable-contracts';
import {
	PortalListRequestSchema,
	type PortalListRequest,
} from '@agent-collaboration/agent-portal-sdk/portal-call-surface';
import {
	PortalEventSchema,
	type PortalEvent,
} from '@agent-collaboration/agent-portal-sdk/portal-event-surface';
import {
	createPortalCallRequestFixture,
	type CreatePortalCallRequestFixtureProps,
} from '@agent-collaboration/agent-portal-sdk/testing';
import {
	ToolPortalMcpClient,
	type ToolPortalMcpTransport,
} from '@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client';
import {
	createNodeToolPortalMcpTransport,
	type CreateNodeToolPortalMcpTransportProps,
} from '@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client/node-transport';

const publicRuntimeExports = [
	PortalCallResultSchema,
	PortalAdapterEnvelopeSchema,
	ApprovalRequiredResultSchema,
	PortalArtifactReadRequestSchema,
	CapabilityDescriptorSchema,
	GatewayRuntimeFrameworkIdentitySchema,
	GatewayRuntimeTrustedInvocationPrincipalSchema,
	ManagedAgentProjectionSchema,
	DEFAULT_GATEWAY_RUNTIME_SOCKET_PATH,
	PortalListRequestSchema,
	PortalEventSchema,
	PORTABLE_CONTRACT_ADAPTERS,
	createPortalCallRequestFixture,
	ToolPortalMcpClient,
	createNodeToolPortalMcpTransport,
] as const;

declare const managedAgentProjection: ManagedAgentProjection;
void managedAgentProjection.toolPortalNamespaces;

type PublicTypeExports = readonly [
	PortalCallResult,
	PortalAdapterEnvelope,
	ApprovalRequiredResult,
	PortalArtifactReadRequest,
	CapabilityDescriptor,
	GatewayRuntimeFrameworkIdentity,
	GatewayRuntimeTrustedInvocationPrincipal,
	ManagedAgentProjection,
	GatewayRuntimeClientOptions,
	PortalListRequest,
	PortalEvent,
	PortableContractAdapter,
	CreatePortalCallRequestFixtureProps,
	ToolPortalMcpTransport,
	CreateNodeToolPortalMcpTransportProps,
];

declare const publicTypeExports: PublicTypeExports;

void publicRuntimeExports;
void publicTypeExports;
