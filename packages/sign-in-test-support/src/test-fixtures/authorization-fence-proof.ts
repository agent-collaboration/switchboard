import { backfillAuthorizationRevisions } from '@agent-collaboration/sign-in-core';
import {
	authorizationFencedAdapter,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins/organization';
import { z } from 'zod';

const whereSchema = z.object({
	field: z.string(),
	value: z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.array(z.string()),
		z.array(z.number()),
		z.null(),
	]),
	operator: z
		.enum([
			'eq',
			'ne',
			'lt',
			'lte',
			'gt',
			'gte',
			'in',
			'not_in',
			'contains',
			'starts_with',
			'ends_with',
		])
		.optional(),
	connector: z.enum(['AND', 'OR']).optional(),
});
const operationSchema = z
	.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('native'),
			path: z.string(),
			body: z.record(z.string(), z.unknown()),
		}),
		z.object({
			kind: z.literal('deleteMany'),
			model: z.enum(['member', 'session', 'organization']),
			where: z.array(whereSchema),
		}),
		z.object({
			kind: z.literal('delete'),
			model: z.enum(['member', 'session', 'organization']),
			where: z.array(whereSchema),
		}),
		z.object({
			kind: z.literal('update'),
			model: z.literal('member'),
			where: z.array(whereSchema),
			update: z.object({ role: z.string() }),
		}),
		z.object({ kind: z.literal('backfill') }),
		z.object({
			kind: z.literal('createMember'),
			id: z.uuidv7(),
			organizationId: z.uuidv7(),
			userId: z.uuidv7(),
		}),
	])
	.and(z.object({ holdBeforeBatch: z.string().optional() }));

/** A wrapper-built native provider over the production fenced adapter, on the real
 * harness host and database. It reaches native routes the product allowlist closes;
 * no allowlist changes. This route exists only in proof entrypoints. */
export async function handleAuthorizationFenceProof(
	request: Request,
	readConfiguration: () => SignInHttpConfiguration,
	beforeBatch: (key: string) => Promise<void>,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== '/__auth-proof/authorization-fence') return null;
	try {
		const input = operationSchema.parse(await request.json());
		const configuration = readConfiguration();
		const platform: SignInHttpConfiguration['platform'] = {
			...configuration.platform,
			async runAtomically(group) {
				if (input.holdBeforeBatch !== undefined) await beforeBatch(input.holdBeforeBatch);
				return configuration.platform.runAtomically(group);
			},
		};
		const native = betterAuth({
			baseURL: configuration.configuration.issuer,
			basePath: '/api/auth',
			secret: configuration.secret,
			database: authorizationFencedAdapter({ openDatabase: configuration.openDatabase, platform }),
			advanced: { database: { generateId: () => configuration.platform.ids.nextId() } },
			session: { cookieCache: { enabled: false } },
			plugins: [
				organization({
					schema: {
						organization: {
							additionalFields: {
								fleetState: {
									type: 'string',
									defaultValue: 'settingUp',
									required: true,
									input: false,
								},
							},
						},
					},
				}),
			],
		});
		if (input.kind === 'backfill')
			return Response.json(
				await backfillAuthorizationRevisions({
					openDatabase: configuration.openDatabase,
					platform,
				}),
			);
		if (input.kind === 'native') {
			const headers = new Headers(request.headers);
			headers.set('content-type', 'application/json');
			if (input.path === 'organization/add-member')
				return Response.json(
					await native.api.addMember({
						body: z
							.object({
								userId: z.string(),
								organizationId: z.string(),
								role: z.enum(['owner', 'admin', 'member']),
							})
							.parse(input.body),
					}),
				);
			return native.handler(
				new Request(new URL(`/api/auth/${input.path}`, request.url), {
					method: 'POST',
					headers,
					body: JSON.stringify(input.body),
				}),
			);
		}
		const { adapter } = await native.$context;
		switch (input.kind) {
			case 'createMember':
				return Response.json(
					await adapter.create({
						model: 'member',
						forceAllowId: true,
						data: {
							id: input.id,
							organizationId: input.organizationId,
							userId: input.userId,
							role: 'member',
							createdAt: new Date(platform.clock.now()),
						},
					}),
				);
			case 'deleteMany':
				return Response.json({ count: await adapter.deleteMany(input) });
			case 'delete':
				await adapter.delete(input);
				return Response.json({ kind: 'complete' });
			case 'update':
				return Response.json({ row: await adapter.update(input) });
		}
	} catch {
		return Response.json({ error: 'authorization-fence-failed' }, { status: 503 });
	}
}
