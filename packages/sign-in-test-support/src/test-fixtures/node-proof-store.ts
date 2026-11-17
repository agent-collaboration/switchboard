import type {
	EpochMilliseconds,
	SignInClock,
	SignInStore,
} from '@agent-collaboration/sign-in-core';

/** Only these already-injected store methods pause. Their production operations
 * still perform every read and return the unchanged result. */
export function decorateNodeProofStore(props: {
	readonly store: SignInStore;
	readonly beforeAgentRead: (clientId: string) => Promise<void>;
	readonly beforeOwnerRead: () => Promise<void>;
	readonly personConfirmation?: {
		readonly clock: SignInClock;
		readonly afterRead: (observation: {
			readonly personId: string;
			readonly sessionId: string;
			readonly checkedAt: EpochMilliseconds;
		}) => Promise<void>;
	};
	readonly onOwnerReadFailure?: (
		reason: 'database-error' | 'migration-incomplete' | 'row-unparseable',
	) => void;
}): SignInStore {
	return {
		...props.store,
		agents: {
			...props.store.agents,
			async read(clientId: string): ReturnType<SignInStore['agents']['read']> {
				await props.beforeAgentRead(clientId);
				return props.store.agents.read(clientId);
			},
		},
		persons: {
			...props.store.persons,
			async isPersonOrganizationSessionActive(
				personId: string,
				sessionId: string,
				organizationId: string,
			): ReturnType<SignInStore['persons']['isPersonOrganizationSessionActive']> {
				const checkedAt = props.personConfirmation?.clock.now();
				const result = await props.store.persons.isPersonOrganizationSessionActive(
					personId,
					sessionId,
					organizationId,
				);
				if (props.personConfirmation !== undefined && checkedAt !== undefined)
					await props.personConfirmation.afterRead({ personId, sessionId, checkedAt });
				return result;
			},
			async readOwnerSession(
				personId: string,
				sessionId: string,
			): ReturnType<SignInStore['persons']['readOwnerSession']> {
				await props.beforeOwnerRead();
				const result = await props.store.persons.readOwnerSession(personId, sessionId);
				if (result.kind === 'store-unavailable') props.onOwnerReadFailure?.(result.reason);
				return result;
			},
		},
	};
}
