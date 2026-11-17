import { APIError } from 'better-auth/api';

import type { AgentClientRecords } from '#sign-in-core/agent-clients/change-agent-client';
import type { ManagementRecordConflict } from '#sign-in-core/storage/agent-registration-store';
import type { PersonSessionRecords } from '#sign-in-core/storage/models/person-session-records';
import type { SignInStoreResult } from '#sign-in-core/storage/models/sign-in-database';
import type { SignInStore } from '#sign-in-core/storage/models/sign-in-store';

export class ManagementOperationConflict extends Error {}

// Better Auth's protocol uses APIError inside its middleware; driver failures stay
// closed store values until this library boundary translates them.
export function requireStoredValue<TValue>(
	result: SignInStoreResult<TValue> | ManagementRecordConflict,
): TValue {
	if (result.kind === 'available') return result.value;
	if (result.kind === 'operation-conflict')
		throw new ManagementOperationConflict(
			'Management request identity conflicts with its recorded intent',
		);
	throw new APIError('SERVICE_UNAVAILABLE', { message: 'sign-in-storage-unavailable' });
}

export function personSessionPorts(records: PersonSessionRecords): {
	readonly providerEmailAllowed: (email: string, verified: boolean) => Promise<boolean>;
	readonly ensurePersonActive: (personId: string) => Promise<boolean>;
	readonly readOwnerSession: (
		personId: string,
		sessionId: string,
	) => Promise<
		import('#sign-in-core/storage/models/person-session-records').LiveOwnerSession | null
	>;
	readonly isPersonSessionActive: (personId: string, sessionId: string) => Promise<boolean>;
	readonly deleteSession: (sessionId: string) => Promise<void>;
	readonly cleanupUnboundPerson: (personId: string) => Promise<void>;
} {
	return {
		providerEmailAllowed: async (email, verified) =>
			requireStoredValue(await records.providerEmailAllowed(email, verified)),
		ensurePersonActive: async (personId) =>
			requireStoredValue(await records.ensurePersonActive(personId)),
		readOwnerSession: async (personId, sessionId) =>
			requireStoredValue(await records.readOwnerSession(personId, sessionId)),
		isPersonSessionActive: async (personId, sessionId) =>
			requireStoredValue(await records.isPersonSessionActive(personId, sessionId)),
		deleteSession: async (sessionId) => requireStoredValue(await records.deleteSession(sessionId)),
		cleanupUnboundPerson: async (personId) =>
			requireStoredValue(await records.cleanupUnboundPerson(personId)),
	};
}

export function agentRegistrationPorts(store: SignInStore): AgentClientRecords {
	return {
		clientExists: async (clientId) => requireStoredValue(await store.agents.clientExists(clientId)),
		read: async (clientId) => requireStoredValue(await store.agents.read(clientId)),
		record: async (change, phase) => requireStoredValue(await store.agents.record(change, phase)),
		complete: async (change) => requireStoredValue(await store.agents.complete(change)),
	};
}

export function workspaceResourcePorts(store: SignInStore): {
	readonly read: import('#sign-in-core/response-release/sign-in-response-release').SignInResponseReleasePorts['readWorkspaceResource'];
	readonly exists: (identifier: string) => Promise<boolean>;
} {
	return {
		read: async (identifier) => requireStoredValue(await store.resources.read(identifier)),
		exists: async (identifier) => requireStoredValue(await store.resources.exists(identifier)),
	};
}

export function workspaceAuditPorts(store: SignInStore): {
	readonly record: (
		event: import('#sign-in-core/storage/workspace-management-audit').WorkspaceManagementAuditEvent,
	) => Promise<void>;
	readonly checkOperation: (
		operation: import('#sign-in-core/agent-clients/agent-registration').AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<void>;
	readonly reserve: (
		operation: import('#sign-in-core/agent-clients/agent-registration').AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<void>;
	readonly finish: (
		operation: import('#sign-in-core/agent-clients/agent-registration').AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<void>;
} {
	return {
		record: async (event) => requireStoredValue(await store.audit.record(event)),
		checkOperation: async (operation, actor, client) =>
			requireStoredValue(await store.audit.checkOperation(operation, actor, client)),
		reserve: async (operation, actor, client) =>
			requireStoredValue(await store.audit.reserve(operation, actor, client)),
		finish: async (operation, actor, client) =>
			requireStoredValue(await store.audit.finish(operation, actor, client)),
	};
}
