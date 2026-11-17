import {
	account,
	oauthClient,
	session,
	signInAudit,
	user,
	member,
	organization,
	invitation,
	twoFactor,
} from '@agent-collaboration/sign-in-core';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';

// These map the real 0000 tables for upgrade input/readback. They create no DDL
// and deliberately omit columns which do not exist until the approved migration.
const baselineUser = sqliteTable('user', {
	id: text('id'),
	name: text('name'),
	email: text('email'),
	emailVerified: integer('emailVerified'),
	image: text('image'),
	createdAt: integer('createdAt'),
	updatedAt: integer('updatedAt'),
});
const baselineSession = sqliteTable('session', {
	id: text('id'),
	expiresAt: integer('expiresAt'),
	token: text('token'),
	createdAt: integer('createdAt'),
	updatedAt: integer('updatedAt'),
	ipAddress: text('ipAddress'),
	userAgent: text('userAgent'),
	userId: text('userId'),
});
const baselineAudit = sqliteTable('sign_in_audit', {
	id: text('id'),
	kind: text('kind'),
	actorUserId: text('actor_user_id'),
	requestId: text('request_id'),
	phase: text('phase'),
	changeKind: text('change_kind'),
	targetId: text('target_id'),
	at: integer('at'),
});
const allowedEmail = sqliteTable('allowed_email', {
	email: text('email'),
	personId: text('person_id'),
	addedBy: text('added_by'),
	addedAt: integer('added_at'),
	removedAt: integer('removed_at'),
});
const deploymentOwner = sqliteTable('deployment_owner', {
	singleton: integer('singleton'),
	userId: text('user_id'),
	boundAt: integer('bound_at'),
});
const admissionClaim = sqliteTable('organization_admission_claim', {
	attemptId: text('attempt_id'),
	personId: text('person_id'),
	organizationId: text('organization_id'),
	claimedAtMs: integer('claimed_at_ms'),
});
const admittedGuard = sqliteTable('admitted_person_guard', {
	personId: text('person_id'),
	organizationId: text('organization_id'),
	admittedAtMs: integer('admitted_at_ms'),
});

export async function seedBaselineUpgrade(context: StorageCaseContext): Promise<unknown> {
	const database = context.openDatabase();
	const personId = context.platform.ids.nextId();
	const organizationId = context.platform.ids.nextId();
	const now = context.platform.clock.now();
	await database.insert(baselineUser).values({
		id: personId,
		name: 'Existing owner',
		email: 'storage-owner@example.invalid',
		emailVerified: 1,
		image: null,
		createdAt: now,
		updatedAt: now,
	});
	await database.insert(account).values({
		id: context.platform.ids.nextId(),
		userId: personId,
		accountId: 'existing-provider-account',
		providerId: 'google',
		createdAt: new Date(now),
		updatedAt: new Date(now),
	});
	await database.insert(baselineSession).values({
		id: context.platform.ids.nextId(),
		userId: personId,
		token: 'existing-opaque-session',
		expiresAt: now + 300_000,
		createdAt: now,
		updatedAt: now,
		ipAddress: '127.0.0.1',
		userAgent: 'baseline-upgrade-proof',
	});
	await database.insert(oauthClient).values({
		id: context.platform.ids.nextId(),
		clientId: 'existing-native-client',
		userId: personId,
		clientSecret: 'test-only-existing-hash',
		redirectUris: '[]',
		grantTypes: '["client_credentials"]',
		clientCredentialsScopes: '["tool-portal:agent"]',
		metadata: '{"kind":"agent"}',
		createdAt: new Date(now),
		updatedAt: new Date(now),
	});
	await database.insert(baselineAudit).values({
		id: context.platform.ids.nextId(),
		kind: 'client-changed',
		actorUserId: personId,
		requestId: context.platform.ids.nextId(),
		phase: 'outcome',
		changeKind: 'registered',
		targetId: 'existing-native-client',
		at: now,
	});
	await database.insert(allowedEmail).values({
		email: 'storage-owner@example.invalid',
		personId,
		addedBy: 'configuration',
		addedAt: now,
		removedAt: null,
	});
	await database.insert(deploymentOwner).values({ singleton: 1, userId: personId, boundAt: now });
	// Old admission records are seeded as well: migration must retire them, never
	// convert a historical claim into native membership or organization authority.
	await database.insert(admissionClaim).values({
		attemptId: context.platform.ids.nextId(),
		personId,
		organizationId,
		claimedAtMs: now,
	});
	await database.insert(admittedGuard).values({ personId, organizationId, admittedAtMs: now });
	return readBaselineUpgrade(context);
}

export async function readBaselineUpgrade(context: StorageCaseContext): Promise<unknown> {
	const database = context.openDatabase();
	const [people, sessions, audit, accounts, clients] = await Promise.all([
		database.select().from(baselineUser).orderBy(baselineUser.id),
		database.select().from(baselineSession).orderBy(baselineSession.id),
		database.select().from(baselineAudit).orderBy(baselineAudit.id),
		database.select().from(account).orderBy(account.id),
		database.select().from(oauthClient).orderBy(oauthClient.id),
	]);
	return { people, sessions, audit, accounts, clients };
}

export async function readUpgradeAdditions(context: StorageCaseContext): Promise<unknown> {
	const database = context.openDatabase();
	return {
		organizations: await database.select().from(organization),
		factors: await database.select().from(twoFactor),
		memberships: await database.select().from(member),
		invitations: await database.select().from(invitation),
		sessions: await database
			.select({
				activeOrganizationId: session.activeOrganizationId,
				secondFactorAt: session.secondFactorAt,
				secondFactorMethod: session.secondFactorMethod,
			})
			.from(session),
		audit: await database.select({ organizationId: signInAudit.organizationId }).from(signInAudit),
		verifiedPeople: await database
			.select({
				id: user.id,
				emailVerified: user.emailVerified,
				twoFactorEnabled: user.twoFactorEnabled,
				secondFactorSetAt: user.secondFactorSetAt,
			})
			.from(user),
	};
}
