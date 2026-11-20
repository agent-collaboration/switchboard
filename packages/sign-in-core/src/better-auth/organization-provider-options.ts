import { APIError } from 'better-auth/api';
import {
	organization,
	type OrganizationOptions,
	type DefaultOrganizationPlugin,
} from 'better-auth/plugins/organization';
import { z } from 'zod';

import {
	organizationAccessControl,
	organizationRoles,
} from '#sign-in-core/better-auth/organization-access-control';
import { createOrganizationRoleHooks } from '#sign-in-core/better-auth/organization-role-hooks';
import type { ProviderRequestState } from '#sign-in-core/better-auth/provider-request-state';
import { requireRecentFactor } from '#sign-in-core/better-auth/second-factor-authorization';
import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	organizationPeopleChangeSchema,
	type OrganizationPeopleChange,
} from '#sign-in-core/organizations/organization-change-record';
import {
	ensureOrganizationProvisioned,
	type SignOrganizationStatement,
} from '#sign-in-core/organizations/organization-provisioning';
import { organizationIdSchema, type SignInStore } from '#sign-in-core/storage/models/sign-in-store';

type SignInOrganizationOptions = OrganizationOptions & {
	readonly ac: typeof organizationAccessControl;
	readonly roles: typeof organizationRoles;
};

export function createOrganizationProviderPlugin(props: {
	readonly ownerEmail: string;
	readonly store: Pick<SignInStore, 'organizations' | 'organizationStamps' | 'peopleChanges'> & {
		readonly factors: Pick<SignInStore['factors'], 'readSession'>;
	};
	readonly platform: Pick<SignInPlatform, 'clock' | 'ids' | 'centralClient' | 'log'>;
	readonly requestState: ProviderRequestState;
	readonly signStatement: SignOrganizationStatement;
}): DefaultOrganizationPlugin<SignInOrganizationOptions> {
	const roles = createOrganizationRoleHooks();
	async function requireOrganizationStepUp(): Promise<void> {
		const actor = props.requestState.organizationActor;
		if (actor.kind !== 'authenticated') throw new APIError('UNAUTHORIZED');
		const factors = requireStoredValue(
			await props.store.factors.readSession(actor.personId, actor.sessionId),
		);
		if (factors === null) throw new APIError('UNAUTHORIZED');
		requireRecentFactor({ clock: props.platform.clock, factors });
	}
	async function beginChange(
		change: OrganizationPeopleChange['change'],
		organizationId: string,
		targetId: string,
	): Promise<void> {
		const actor = props.requestState.organizationActor;
		if (actor.kind !== 'authenticated') throw new APIError('UNAUTHORIZED');
		await requireOrganizationStepUp();
		if (props.requestState.peopleChange.kind !== 'none')
			throw new APIError('CONFLICT', { message: 'people-change-already-started' });
		const identity = organizationPeopleChangeSchema.parse({
			requestId: props.platform.ids.nextId(),
			actorUserId: actor.personId,
			organizationId,
			change,
			targetId,
		});
		requireStoredValue(await props.store.peopleChanges.record(identity, 'intent'));
		props.requestState.peopleChange = { kind: 'intent-recorded', change: identity };
	}
	async function finishChange(
		change: OrganizationPeopleChange['change'],
		organizationId: string,
		targetId: string,
	): Promise<void> {
		const recorded = props.requestState.peopleChange;
		if (
			recorded.kind !== 'intent-recorded' ||
			recorded.change.change !== change ||
			recorded.change.organizationId !== organizationId ||
			recorded.change.targetId !== targetId
		)
			throw new APIError('SERVICE_UNAVAILABLE', { message: 'people-change-intent-unconfirmed' });
		const outcome = await props.store.peopleChanges.record(recorded.change, 'outcome');
		if (outcome.kind === 'store-unavailable') {
			props.platform.log({
				kind: 'people-change-unconfirmed',
				organizationId: recorded.change.organizationId,
				requestId: recorded.change.requestId,
				reason: outcome.reason,
			});
			requireStoredValue(outcome);
		}
	}
	const options: SignInOrganizationOptions = {
		ac: organizationAccessControl,
		roles: organizationRoles,
		creatorRole: 'owner',
		teams: { enabled: false },
		dynamicAccessControl: { enabled: false },
		requireEmailVerificationOnInvitation: true,
		cancelPendingInvitationsOnReInvite: false,
		allowUserToCreateOrganization: (person): boolean =>
			person.emailVerified && person.email.toLowerCase() === props.ownerEmail.toLowerCase(),
		schema: {
			organization: {
				additionalFields: {
					fleetState: { type: 'string', required: true, defaultValue: 'settingUp', input: false },
					// The stamp record: only the server writes it (owner, 9 Nov; B2 renew-on-use).
					fleetStampDigest: { type: 'string', required: false, input: false },
					fleetStampExpiresAt: { type: 'number', required: false, input: false },
					fleetStampSigningKeyId: { type: 'string', required: false, input: false },
					fleetStampSent: { type: 'string', required: false, input: false },
					fleetStampRenewedAt: { type: 'date', required: false, input: false },
					fleetStampUnansweredTries: {
						type: 'number',
						required: true,
						defaultValue: 0,
						input: false,
					},
					fleetStampRefusedTries: { type: 'number', required: true, defaultValue: 0, input: false },
					fleetStampLastTryAt: { type: 'date', required: false, input: false },
					fleetStampLastTryOutcome: { type: 'string', required: false, input: false },
				},
			},
		},
		organizationHooks: {
			...roles,
			beforeCreateOrganization: async (): Promise<void> => requireOrganizationStepUp(),
			async beforeUpdateMemberRole(data): Promise<void> {
				await roles.beforeUpdateMemberRole(data);
				await requireOrganizationStepUp();
			},
			async beforeCreateInvitation(data): Promise<void> {
				await roles.beforeCreateInvitation(data);
				await beginChange('invited', data.organization.id, data.invitation.email.toLowerCase());
			},
			async afterCreateInvitation(data): Promise<void> {
				await finishChange('invited', data.organization.id, data.invitation.email.toLowerCase());
			},
			async beforeCancelInvitation(data): Promise<void> {
				await beginChange('invitation-cancelled', data.organization.id, data.invitation.id);
			},
			async afterCancelInvitation(data): Promise<void> {
				await finishChange('invitation-cancelled', data.organization.id, data.invitation.id);
			},
			async beforeAcceptInvitation(data): Promise<void> {
				if (!z.literal('member').safeParse(data.invitation.role).success)
					throw new APIError('FORBIDDEN', { message: 'invitation-role-not-allowed' });
				await beginChange('invitation-accepted', data.organization.id, data.invitation.id);
			},
			async afterAcceptInvitation(data): Promise<void> {
				await finishChange('invitation-accepted', data.organization.id, data.invitation.id);
			},
			async beforeRemoveMember(data): Promise<void> {
				await roles.beforeRemoveMember(data);
				await beginChange('member-removed', data.organization.id, data.member.userId);
			},
			async afterRemoveMember(data): Promise<void> {
				await finishChange('member-removed', data.organization.id, data.member.userId);
			},
			async afterCreateOrganization(data): Promise<void> {
				const organizationId = organizationIdSchema.parse(data.organization.id);
				const result = await ensureOrganizationProvisioned({
					organizationId,
					store: props.store.organizations,
					stamps: props.store.organizationStamps,
					centralClient: props.platform.centralClient,
					signStatement: props.signStatement,
				});
				if (result.kind === 'ready') return;
				props.platform.log({
					kind: 'organization-setup-unconfirmed',
					organizationId,
					reason: result.kind === 'not-found' ? 'not-found' : result.reason,
				});
			},
		},
	};
	return organization(options);
}
