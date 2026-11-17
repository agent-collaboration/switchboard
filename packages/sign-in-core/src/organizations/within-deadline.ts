/**
 * Settles with `atDeadline` once the run's deadline fires, whether or not the call honours its
 * signal; a call that settles first keeps its own answer. A later rejection stays handled.
 */
export async function withinDeadline<TAnswer>(
	deadline: AbortSignal,
	call: () => Promise<TAnswer>,
	atDeadline: TAnswer,
): Promise<TAnswer> {
	if (deadline.aborted) return atDeadline;
	const { promise: reached, resolve } = Promise.withResolvers<TAnswer>();
	const onDeadline = (): void => resolve(atDeadline);
	deadline.addEventListener('abort', onDeadline, { once: true });
	try {
		return await Promise.race([call(), reached]);
	} finally {
		deadline.removeEventListener('abort', onDeadline);
	}
}
