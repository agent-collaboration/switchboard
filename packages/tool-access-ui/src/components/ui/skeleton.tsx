// Third-party notices: THIRD_PARTY_NOTICES.md#shadcn-ui (repository root).
import { cn } from 'cn';
import type { ComponentProps, ReactElement } from 'react';

function Skeleton({ className, ...props }: ComponentProps<'div'>): ReactElement {
	return (
		<div
			data-slot="skeleton"
			className={cn('animate-pulse rounded-md bg-muted', className)}
			{...props}
		/>
	);
}

export { Skeleton };
