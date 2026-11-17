import type { BetterAuthOptions } from 'better-auth';
import { createAdapterFactory, type DBAdapter, type CustomAdapter } from 'better-auth/adapters';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { fencedPredicate } from '#sign-in-core/better-auth/authorization-fence-predicates';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	createAuthorizationFenceMutations,
	type AuthorizationFenceMutations,
} from '#sign-in-core/storage/authorization-fence-mutations';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import { signInSchema } from '#sign-in-core/storage/sign-in-schema';

/**
 * Better Auth's stock Drizzle adapter, with every member, organization and session write
 * that moves an authorization fence routed through one fixed batch. Composed through the
 * public adapter factory: neither the stock adapter nor Better Auth is patched.
 */
export function authorizationFencedAdapter(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'runAtomically' | 'clock' | 'ids'>;
	/** Told after each fenced batch commits, so the request can hint a drain once it responds. */
	readonly onFenceCommitted?: () => void;
}): (options: BetterAuthOptions) => DBAdapter {
	return (options: BetterAuthOptions): DBAdapter => {
		const stock = drizzleAdapter(props.openDatabase(), {
			provider: 'sqlite',
			schema: signInSchema,
			transaction: false,
		})(options);
		const batches = createAuthorizationFenceMutations(props);
		function committed<TResult>(result: TResult): TResult {
			props.onFenceCommitted?.();
			return result;
		}
		const mutations: AuthorizationFenceMutations = {
			createMember: async (input) => committed(await batches.createMember(input)),
			createOrganization: async (input) => committed(await batches.createOrganization(input)),
			updateMember: async (predicate, input) =>
				committed(await batches.updateMember(predicate, input)),
			deleteRows: async (model, predicate) => committed(await batches.deleteRows(model, predicate)),
		};
		const fenced = createAdapterFactory({
			config: {
				adapterId: 'authorization-fenced-drizzle',
				supportsDates: true,
				supportsBooleans: true,
				supportsJSON: false,
				transaction: false,
			},
			adapter: (): CustomAdapter => ({
				async create({ model, data }) {
					const row =
						model === 'member'
							? await mutations.createMember(data)
							: model === 'organization'
								? await mutations.createOrganization(data)
								: undefined;
					if (row === undefined) throw new Error(`Unrouted create: ${model}`);
					return Object.assign({}, data, row);
				},
				async update({ model, where, update }) {
					if (model !== 'member') throw new Error(`Unrouted update: ${model}`);
					const rows = await mutations.updateMember(fencedPredicate('member', where), update);
					return rows.length === 0 ? null : Object.assign({}, update, rows[0]);
				},
				async updateMany({ model, where, update }): Promise<number> {
					if (model !== 'member') throw new Error(`Unrouted updateMany: ${model}`);
					return (await mutations.updateMember(fencedPredicate('member', where), update)).length;
				},
				async delete({ model, where }): Promise<void> {
					if (model !== 'member' && model !== 'session' && model !== 'organization')
						throw new Error(`Unrouted delete: ${model}`);
					await mutations.deleteRows(model, fencedPredicate(model, where));
				},
				async deleteMany({ model, where }): Promise<number> {
					if (model !== 'member' && model !== 'session' && model !== 'organization')
						throw new Error(`Unrouted deleteMany: ${model}`);
					return mutations.deleteRows(model, fencedPredicate(model, where));
				},
				findOne: stock.findOne,
				findMany: stock.findMany,
				count: stock.count,
			}),
		})(options);
		const composed: DBAdapter = {
			...stock,
			create: (input) =>
				input.model === 'member' || input.model === 'organization'
					? fenced.create(input)
					: stock.create(input),
			update: (input) => (input.model === 'member' ? fenced.update(input) : stock.update(input)),
			updateMany: (input) =>
				input.model === 'member' ? fenced.updateMany(input) : stock.updateMany(input),
			delete: (input) =>
				['member', 'session', 'organization'].includes(input.model)
					? fenced.delete(input)
					: stock.delete(input),
			deleteMany: (input) =>
				['member', 'session', 'organization'].includes(input.model)
					? fenced.deleteMany(input)
					: stock.deleteMany(input),
			// Native organization helpers call transaction even with transaction:false.
			// Keep their callback on this public composition; each DML owns its batch.
			transaction: async (callback) => callback(composed),
		};
		return composed;
	};
}
