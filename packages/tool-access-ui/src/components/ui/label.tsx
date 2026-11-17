// Third-party notices: THIRD_PARTY_NOTICES.md#shadcn-ui (repository root).
import { cn } from 'cn';
import * as React from 'react';

function Label({ className, ...props }: React.ComponentProps<'label'>): React.ReactElement {
	return (
		<label
			data-slot="label"
			className={cn(
				'flex items-center gap-2 text-xs font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:text-faint-foreground peer-disabled:cursor-not-allowed peer-disabled:text-faint-foreground',
				className,
			)}
			{...props}
		/>
	);
}

export { Label };
