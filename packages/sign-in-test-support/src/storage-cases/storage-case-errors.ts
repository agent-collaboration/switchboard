/** Preserve a diagnostic without exporting Drizzle's bound credential values. */
export function storageCaseErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) return 'Storage case failed';
	let cause: unknown = error;
	while (cause instanceof Error) {
		const schemaDiagnostic =
			/(?:not authorized to use function: pragma_[a-z_]+|no such (?:table|function): [\w_]+|near "[\w_]+": syntax error)/iu.exec(
				cause.message,
			)?.[0];
		if (schemaDiagnostic !== undefined) return schemaDiagnostic;
		const constraint =
			/(?:not null|unique|foreign key|check) constraint failed(?:: [\w., ]+)?/iu.exec(
				cause.message,
			)?.[0];
		if (constraint !== undefined) return constraint;
		cause = cause.cause;
	}
	return error.message.split('\nparams:')[0] ?? 'Storage case failed';
}

export type StorageCaseExecution =
	| { readonly kind: 'result'; readonly value: unknown }
	| { readonly kind: 'case-error'; readonly message: string };

export async function captureStorageCase(
	execute: () => Promise<unknown>,
): Promise<StorageCaseExecution> {
	try {
		return { kind: 'result', value: await execute() };
	} catch (error) {
		return { kind: 'case-error', message: storageCaseErrorMessage(error) };
	}
}
