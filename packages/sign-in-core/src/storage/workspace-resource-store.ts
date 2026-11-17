import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	workspaceResourceSchema,
	type WorkspaceResource,
} from '#sign-in-core/agent-clients/workspace-resource';
import { jsonTextSchema } from '#sign-in-core/storage/json-text-schema';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import { oauthResource } from '#sign-in-core/storage/sign-in-schema';
import { availableStoreValue, readStoreValue } from '#sign-in-core/storage/store-query-results';

export interface WorkspaceResourceRecords {
	readonly read: (identifier: string) => Promise<SignInStoreResult<WorkspaceResource | null>>;
	readonly exists: (identifier: string) => Promise<SignInStoreResult<boolean>>;
}
const workspaceResourceRowSchema = workspaceResourceSchema.extend({
	metadata: jsonTextSchema(workspaceResourceSchema.shape.metadata.nullable()).nullable(),
	allowedScopes: jsonTextSchema(workspaceResourceSchema.shape.allowedScopes).nullable(),
	customClaims: jsonTextSchema(workspaceResourceSchema.shape.customClaims).nullable(),
	disabled: z.boolean().nullable().transform(Boolean),
});

export function createWorkspaceResourceStore(
	database: SignInDatabaseFactory,
): WorkspaceResourceRecords {
	return {
		async exists(identifier): Promise<SignInStoreResult<boolean>> {
			const rows = await readStoreValue(
				async () =>
					await database()
						.select({ identifier: oauthResource.identifier })
						.from(oauthResource)
						.where(eq(oauthResource.identifier, identifier))
						.limit(1),
				z.array(z.object({ identifier: z.string() })),
			);
			return rows.kind === 'available' ? availableStoreValue(rows.value.length > 0) : rows;
		},
		async read(identifier): Promise<SignInStoreResult<WorkspaceResource | null>> {
			const resource = await readStoreValue(
				async () =>
					(
						await database()
							.select({
								identifier: oauthResource.identifier,
								metadata: oauthResource.metadata,
								allowedScopes: oauthResource.allowedScopes,
								customClaims: oauthResource.customClaims,
								disabled: oauthResource.disabled,
							})
							.from(oauthResource)
							.where(eq(oauthResource.identifier, identifier))
							.limit(1)
					)[0] ?? null,
				workspaceResourceRowSchema.nullable(),
			);
			if (resource.kind !== 'available') return resource;
			// Better Auth's management resource legitimately has no workspace metadata.
			if (resource.value === null || resource.value.metadata === null)
				return availableStoreValue(null);
			return availableStoreValue({ ...resource.value, metadata: resource.value.metadata });
		},
	};
}
