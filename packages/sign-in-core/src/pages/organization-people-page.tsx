/** @jsxImportSource react */
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
} from '@agent-collaboration/tool-access-ui/server';
import type * as React from 'react';

import type { PageNonce } from '#sign-in-core/contracts/page-nonce';
import {
	IslandRoot,
	pageDocument,
	signInPagesIslandScript,
} from '#sign-in-core/pages/page-document';
import type { OrganizationId } from '#sign-in-core/storage/models/sign-in-store';

export function renderOrganizationPeoplePage(props: {
	readonly organizationId: OrganizationId;
	readonly organizationName: string;
	readonly nonce: PageNonce;
	readonly headers?: Headers;
}): Response {
	const content: React.ReactElement = (
		<IslandRoot
			state={{
				kind: 'organization-people',
				organizationId: props.organizationId,
				organizationName: props.organizationName,
			}}
			fallback={
				<Card>
					<CardHeader>
						<CardTitle>People</CardTitle>
						<CardDescription>{props.organizationName}</CardDescription>
					</CardHeader>
					<CardContent>
						<Skeleton className="h-16 w-full" />
						<noscript>Enable JavaScript to read this organization's people.</noscript>
					</CardContent>
				</Card>
			}
		/>
	);
	const document = pageDocument({
		title: 'People',
		nonce: props.nonce,
		...(props.headers === undefined ? {} : { headers: props.headers }),
		challenge: 'none',
		scripts: signInPagesIslandScript,
		children: content,
	});
	return new Response(document.html, { headers: document.headers });
}
