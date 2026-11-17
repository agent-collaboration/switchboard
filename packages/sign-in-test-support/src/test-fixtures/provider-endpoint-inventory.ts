import { createProviderRequestState } from '@agent-collaboration/sign-in-core/better-auth';
import {
	createSignInProvider,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { signInWorkerConfiguration } from '@agent-collaboration/sign-in-host-cloudflare/configuration';
import type { Miniflare } from 'miniflare';
import { z } from 'zod';

const endpointSchema = z.object({
	path: z.string().startsWith('/').optional(),
	options: z.object({
		method: z.union([z.string(), z.array(z.string())]),
		metadata: z.object({ SERVER_ONLY: z.boolean().optional() }).optional(),
	}),
});
export interface ProviderHttpRoute {
	readonly endpointName: string;
	readonly method: string;
	readonly path: string;
	readonly serverOnly: boolean;
}
export interface ProviderApiWithoutHttpPath {
	readonly endpointName: string;
	readonly serverOnly: boolean;
}
export interface ProviderEndpointInventory {
	readonly httpRoutes: readonly ProviderHttpRoute[];
	readonly noHttpPathApis: readonly ProviderApiWithoutHttpPath[];
}

/** Includes every installed API; pathless server APIs stay explicit beside the HTTP method matrix. */
export async function installedProviderEndpointInventory(
	runtime: Miniflare,
	configuration?: SignInHttpConfiguration,
): Promise<ProviderEndpointInventory> {
	const selectedConfiguration =
		configuration ?? signInWorkerConfiguration(await runtime.getBindings<AuthWorkerEnv>('sign-in'));
	const provider = createSignInProvider({
		...selectedConfiguration,
		authority: { kind: 'public' },
		requestState: createProviderRequestState(),
	});
	await provider.$context;
	const noHttpPathApis: ProviderApiWithoutHttpPath[] = [];
	const httpRoutes = Object.entries(provider.api).flatMap(([endpointName, endpoint]) => {
		const descriptor = endpointSchema.parse({ path: endpoint.path, options: endpoint.options });
		if (descriptor.path === undefined) {
			noHttpPathApis.push({
				endpointName,
				serverOnly: descriptor.options.metadata?.SERVER_ONLY === true,
			});
			return [];
		}
		const methods = Array.isArray(descriptor.options.method)
			? descriptor.options.method
			: [descriptor.options.method];
		return methods.flatMap((method) =>
			(method === '*'
				? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
				: [method]
			).map((httpMethod) => ({
				endpointName,
				method: httpMethod,
				path: `/api/auth${descriptor.path}`,
				serverOnly: descriptor.options.metadata?.SERVER_ONLY === true,
			})),
		);
	});
	return {
		httpRoutes,
		noHttpPathApis: noHttpPathApis.toSorted((left, right) =>
			left.endpointName.localeCompare(right.endpointName),
		),
	};
}
