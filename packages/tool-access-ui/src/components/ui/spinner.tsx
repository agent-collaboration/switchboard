// Third-party notices: THIRD_PARTY_NOTICES.md#shadcn-ui (repository root).
import { cn } from 'cn';
import { Loader2Icon } from 'lucide-react';
import type * as React from 'react';

function Spinner({ className, ...props }: React.ComponentProps<'svg'>): React.ReactElement {
	return (
		<Loader2Icon
			data-slot="spinner"
			role="status"
			aria-label="Loading"
			className={cn('size-4 animate-spin', className)}
			{...props}
		/>
	);
}

export { Spinner };
