export type OrganizationBrowserFailure =
	| { readonly kind: 'none' }
	| { readonly kind: 'failed'; readonly error: unknown };

export async function closeOrganizationBrowserScenario(props: {
	readonly failure: OrganizationBrowserFailure;
	readonly record?: () => Promise<void>;
	readonly close: () => Promise<void>;
}): Promise<void> {
	const failures: unknown[] = [];
	switch (props.failure.kind) {
		case 'none':
			break;
		case 'failed':
			failures.push(props.failure.error);
			break;
		default: {
			const unhandled: never = props.failure;
			throw new Error(`Unknown organization browser failure: ${String(unhandled)}`);
		}
	}
	try {
		await props.record?.();
	} catch (recordingError) {
		failures.push(recordingError);
	}
	try {
		await props.close();
	} catch (closeError) {
		failures.push(closeError);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(
			failures,
			'Organization browser scenario, observation or cleanup failed',
			{ cause: failures[0] },
		);
}
