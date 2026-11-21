import type {
	GoogleCatalogFamilyId,
	GoogleOperationEffect,
} from '@agent-collaboration/oauth-broker-contracts';

interface LiteralPermissionGroup {
	readonly groupId: string;
	readonly familyId: GoogleCatalogFamilyId;
	readonly serviceId: string;
	readonly effect: GoogleOperationEffect;
	readonly scope: string;
}

// Independent oracle for the pinned catalog. No compiler, catalog getter or mapping helper
// supplies these scopes or the local service/effect support below.
export const literalPermissionGroups: readonly LiteralPermissionGroup[] = [
	{
		groupId: 'gmail.read',
		familyId: 'communications',
		serviceId: 'gmail',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/gmail.readonly',
	},
	{
		groupId: 'gmail.write',
		familyId: 'communications',
		serviceId: 'gmail',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/gmail.modify',
	},
	{
		groupId: 'calendar.read',
		familyId: 'communications',
		serviceId: 'calendar',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/calendar.readonly',
	},
	{
		groupId: 'calendar.write',
		familyId: 'communications',
		serviceId: 'calendar',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/calendar.events',
	},
	{
		groupId: 'contacts.read',
		familyId: 'communications',
		serviceId: 'contacts',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/contacts.readonly',
	},
	{
		groupId: 'contacts.write',
		familyId: 'communications',
		serviceId: 'contacts',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/contacts',
	},
	{
		groupId: 'forms.body.read',
		familyId: 'documents',
		serviceId: 'forms',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/forms.body.readonly',
	},
	{
		groupId: 'forms.body.write',
		familyId: 'documents',
		serviceId: 'forms',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/forms.body',
	},
	{
		groupId: 'forms.responses.read',
		familyId: 'documents',
		serviceId: 'forms',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/forms.responses.readonly',
	},
	{
		groupId: 'youtube.read',
		familyId: 'youtube',
		serviceId: 'youtube',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/youtube.readonly',
	},
	{
		groupId: 'youtube.write',
		familyId: 'youtube',
		serviceId: 'youtube',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
	},
	{
		groupId: 'drive.all-files.read',
		familyId: 'documents',
		serviceId: 'drive',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/drive.readonly',
	},
	{
		groupId: 'drive.all-files.write',
		familyId: 'documents',
		serviceId: 'drive',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/drive',
	},
	{
		groupId: 'drive.app-files.read',
		familyId: 'documents',
		serviceId: 'drive',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/drive.file',
	},
	{
		groupId: 'drive.app-files.write',
		familyId: 'documents',
		serviceId: 'drive',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/drive.file',
	},
	{
		groupId: 'docs.all-files.read',
		familyId: 'documents',
		serviceId: 'docs',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/drive.readonly',
	},
	{
		groupId: 'docs.all-files.write',
		familyId: 'documents',
		serviceId: 'docs',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/drive',
	},
	{
		groupId: 'docs.app-files.read',
		familyId: 'documents',
		serviceId: 'docs',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/drive.file',
	},
	{
		groupId: 'docs.app-files.write',
		familyId: 'documents',
		serviceId: 'docs',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/drive.file',
	},
	{
		groupId: 'sheets.all-files.read',
		familyId: 'documents',
		serviceId: 'sheets',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/drive.readonly',
	},
	{
		groupId: 'sheets.all-files.write',
		familyId: 'documents',
		serviceId: 'sheets',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/drive',
	},
	{
		groupId: 'sheets.app-files.read',
		familyId: 'documents',
		serviceId: 'sheets',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/drive.file',
	},
	{
		groupId: 'sheets.app-files.write',
		familyId: 'documents',
		serviceId: 'sheets',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/drive.file',
	},
	{
		groupId: 'slides.all-files.read',
		familyId: 'documents',
		serviceId: 'slides',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/drive.readonly',
	},
	{
		groupId: 'slides.all-files.write',
		familyId: 'documents',
		serviceId: 'slides',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/drive',
	},
	{
		groupId: 'slides.app-files.read',
		familyId: 'documents',
		serviceId: 'slides',
		effect: 'read',
		scope: 'https://www.googleapis.com/auth/drive.file',
	},
	{
		groupId: 'slides.app-files.write',
		familyId: 'documents',
		serviceId: 'slides',
		effect: 'write',
		scope: 'https://www.googleapis.com/auth/drive.file',
	},
];

interface LiteralOperation {
	readonly operationId: string;
	readonly familyId: GoogleCatalogFamilyId;
	readonly requiredGroupChoices: readonly (readonly string[])[];
}

// Each inner list is an alternative for ONE required local effect. Every list must
// be satisfied, even if a provider's write scope technically permits helper reads.
export const literalOperations: readonly LiteralOperation[] = [
	{
		operationId: 'drive.upload',
		familyId: 'documents',
		requiredGroupChoices: [['drive.all-files.write', 'drive.app-files.write']],
	},
	{
		operationId: 'drive.download',
		familyId: 'documents',
		requiredGroupChoices: [['drive.all-files.read', 'drive.app-files.read']],
	},
	{
		operationId: 'docs.export',
		familyId: 'documents',
		requiredGroupChoices: [['docs.all-files.read', 'docs.app-files.read']],
	},
	{
		operationId: 'sheets.export',
		familyId: 'documents',
		requiredGroupChoices: [['sheets.all-files.read', 'sheets.app-files.read']],
	},
	{
		operationId: 'slides.export',
		familyId: 'documents',
		requiredGroupChoices: [['slides.all-files.read', 'slides.app-files.read']],
	},
	{
		operationId: 'gmail.search',
		familyId: 'communications',
		requiredGroupChoices: [['gmail.read']],
	},
	{ operationId: 'gmail.get', familyId: 'communications', requiredGroupChoices: [['gmail.read']] },
	{
		operationId: 'gmail.drafts.list',
		familyId: 'communications',
		requiredGroupChoices: [['gmail.read']],
	},
	{
		operationId: 'gmail.drafts.get',
		familyId: 'communications',
		requiredGroupChoices: [['gmail.read']],
	},
	{
		operationId: 'gmail.drafts.create',
		familyId: 'communications',
		requiredGroupChoices: [['gmail.read'], ['gmail.write']],
	},
	{
		operationId: 'gmail.drafts.send',
		familyId: 'communications',
		requiredGroupChoices: [['gmail.write']],
	},
	{
		operationId: 'gmail.drafts.delete',
		familyId: 'communications',
		requiredGroupChoices: [['gmail.write']],
	},
	{
		operationId: 'gmail.send',
		familyId: 'communications',
		requiredGroupChoices: [['gmail.read'], ['gmail.write']],
	},
	{
		operationId: 'calendar.events',
		familyId: 'communications',
		requiredGroupChoices: [['calendar.read']],
	},
	{
		operationId: 'calendar.create',
		familyId: 'communications',
		requiredGroupChoices: [['calendar.read'], ['calendar.write']],
	},
	{
		operationId: 'calendar.delete',
		familyId: 'communications',
		requiredGroupChoices: [['calendar.read'], ['calendar.write']],
	},
	{
		operationId: 'contacts.list',
		familyId: 'communications',
		requiredGroupChoices: [['contacts.read']],
	},
	{
		operationId: 'contacts.search',
		familyId: 'communications',
		requiredGroupChoices: [['contacts.read']],
	},
	{
		operationId: 'contacts.create',
		familyId: 'communications',
		requiredGroupChoices: [['contacts.write']],
	},
	{
		operationId: 'contacts.delete',
		familyId: 'communications',
		requiredGroupChoices: [['contacts.write']],
	},
	{
		operationId: 'drive.ls',
		familyId: 'documents',
		requiredGroupChoices: [['drive.all-files.read', 'drive.app-files.read']],
	},
	{
		operationId: 'drive.get',
		familyId: 'documents',
		requiredGroupChoices: [['drive.all-files.read', 'drive.app-files.read']],
	},
	{
		operationId: 'drive.search',
		familyId: 'documents',
		requiredGroupChoices: [['drive.all-files.read', 'drive.app-files.read']],
	},
	{
		operationId: 'drive.delete',
		familyId: 'documents',
		requiredGroupChoices: [['drive.all-files.write', 'drive.app-files.write']],
	},
	{
		operationId: 'drive.move',
		familyId: 'documents',
		requiredGroupChoices: [
			['drive.all-files.read', 'drive.app-files.read'],
			['drive.all-files.write', 'drive.app-files.write'],
		],
	},
	{
		operationId: 'docs.info',
		familyId: 'documents',
		requiredGroupChoices: [['docs.all-files.read', 'docs.app-files.read']],
	},
	{
		operationId: 'docs.cat',
		familyId: 'documents',
		requiredGroupChoices: [['docs.all-files.read', 'docs.app-files.read']],
	},
	{
		operationId: 'docs.write',
		familyId: 'documents',
		requiredGroupChoices: [
			['docs.all-files.read', 'docs.app-files.read'],
			['docs.all-files.write', 'docs.app-files.write'],
		],
	},
	{
		operationId: 'sheets.get',
		familyId: 'documents',
		requiredGroupChoices: [['sheets.all-files.read', 'sheets.app-files.read']],
	},
	{
		operationId: 'sheets.update',
		familyId: 'documents',
		requiredGroupChoices: [
			['sheets.all-files.read', 'sheets.app-files.read'],
			['sheets.all-files.write', 'sheets.app-files.write'],
		],
	},
	{
		operationId: 'slides.info',
		familyId: 'documents',
		requiredGroupChoices: [['slides.all-files.read', 'slides.app-files.read']],
	},
	{
		operationId: 'slides.insert-text',
		familyId: 'documents',
		requiredGroupChoices: [['slides.all-files.write', 'slides.app-files.write']],
	},
	{ operationId: 'forms.get', familyId: 'documents', requiredGroupChoices: [['forms.body.read']] },
	{
		operationId: 'forms.create',
		familyId: 'documents',
		requiredGroupChoices: [['forms.body.write']],
	},
	{
		operationId: 'forms.responses.list',
		familyId: 'documents',
		requiredGroupChoices: [['forms.responses.read']],
	},
	{
		operationId: 'youtube.channels.list',
		familyId: 'youtube',
		requiredGroupChoices: [['youtube.read']],
	},
	{
		operationId: 'youtube.playlists.create',
		familyId: 'youtube',
		requiredGroupChoices: [['youtube.write']],
	},
];

export const literalIdentityScopes = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];

export function literalSelectionModel(props: {
	readonly familyId: GoogleCatalogFamilyId;
	readonly groupIds: readonly string[];
	readonly ceiling: readonly string[];
}):
	| { readonly kind: 'refused' }
	| {
			readonly kind: 'compiled';
			readonly scopes: readonly string[];
			readonly effects: Readonly<Record<string, readonly GoogleOperationEffect[]>>;
	  } {
	const selectedGroups = props.groupIds.map((groupId: string): LiteralPermissionGroup | undefined =>
		literalPermissionGroups.find(
			(group: LiteralPermissionGroup): boolean => group.groupId === groupId,
		),
	);
	if (
		props.ceiling.some(
			(groupId: string): boolean =>
				literalPermissionGroups.find(
					(group: LiteralPermissionGroup): boolean => group.groupId === groupId,
				)?.familyId !== props.familyId,
		) ||
		selectedGroups.some(
			(group: LiteralPermissionGroup | undefined): boolean =>
				group === undefined ||
				group.familyId !== props.familyId ||
				!props.ceiling.includes(group.groupId),
		)
	)
		return { kind: 'refused' };
	const scopes: string[] = [];
	const effects: Record<string, GoogleOperationEffect[]> = {};
	for (const group of selectedGroups) {
		if (group === undefined)
			throw new Error('Literal selection validation failed to narrow a group.');
		scopes.push(group.scope);
		const serviceEffects = effects[group.serviceId] ?? [];
		if (!serviceEffects.includes(group.effect)) serviceEffects.push(group.effect);
		effects[group.serviceId] = serviceEffects.toSorted();
	}
	return { kind: 'compiled', scopes: [...new Set(scopes)].toSorted(), effects };
}

export function literalGrantModel(props: {
	readonly operationId: string;
	readonly selectedGroupIds: readonly string[];
	readonly ceiling: readonly string[];
	readonly actualScopes: readonly string[];
}): { readonly kind: 'admitted' | 'unavailable' | 'scope-mismatch' | 'consent-required' } {
	const operation = literalOperations.find(
		(candidate: LiteralOperation): boolean => candidate.operationId === props.operationId,
	);
	if (operation === undefined) return { kind: 'unavailable' };
	const selection = literalSelectionModel({
		familyId: operation.familyId,
		groupIds: props.selectedGroupIds,
		ceiling: props.ceiling,
	});
	if (selection.kind === 'refused') return { kind: 'unavailable' };
	const expectedScopes = [...new Set([...literalIdentityScopes, ...selection.scopes])].toSorted();
	if (
		JSON.stringify([...new Set(props.actualScopes)].toSorted()) !== JSON.stringify(expectedScopes)
	)
		return { kind: 'scope-mismatch' };
	const completeSupport = operation.requiredGroupChoices.every(
		(choices: readonly string[]): boolean =>
			choices.some((groupId: string): boolean => props.selectedGroupIds.includes(groupId)),
	);
	return { kind: completeSupport ? 'admitted' : 'consent-required' };
}
