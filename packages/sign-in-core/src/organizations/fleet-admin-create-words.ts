/**
 * What a person is told about a workspace create, in the admin page and the owner CLI alike.
 * `created` also covers a create central answered `nameInUse` whose own workspace one lookup
 * found under the same name (an earlier send of that operation created it).
 */
export const fleetAdminCreateWords = {
	created: 'Workspace created.',
	nameInUse: 'A workspace with that name already exists.',
	conflict: 'That request was already used for a different workspace. Try again.',
} as const;
