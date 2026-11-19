export type OrganizationBrowserFailure =
	| { readonly kind: 'none' }
	| { readonly kind: 'failed'; readonly error: unknown };

export async function closeOrganizationBrowserScenario(props: {
	readonly failure: OrganizationBrowserFailure;
	readonly close: () => Promise<void>;
}): Promise<void> {
	let closeFailure: OrganizationBrowserFailure = { kind: 'none' };
	try {
		await props.close();
	} catch (closeError) {
		closeFailure = { kind: 'failed', error: closeError };
	}
	switch (props.failure.kind) {
		case 'none':
			if (closeFailure.kind === 'failed') throw closeFailure.error;
			return;
		case 'failed': {
			if (closeFailure.kind === 'failed') {
				// Keep the original error intact, including a pre-existing cause or frozen properties.
				throw new AggregateError(
					[props.failure.error, closeFailure.error],
					'Organization browser scenario failed; cleanup also failed',
					{ cause: props.failure.error },
				);
			}
			throw props.failure.error;
		}
		default: {
			const unhandled: never = props.failure;
			throw new Error(`Unknown organization browser failure: ${String(unhandled)}`);
		}
	}
}
