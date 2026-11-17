import { z } from 'zod';

import { setControlledWorkerTime } from '#sign-in-test-support/test-fixtures/controlled-worker-date';

export async function handleAuthProofClockControl(request: Request): Promise<Response | null> {
	if (new URL(request.url).pathname !== '/__auth-proof/set-clock') return null;
	if (request.method !== 'POST') return new Response(null, { status: 405 });
	const input = z
		.strictObject({ milliseconds: z.number().int().nonnegative() })
		.parse(await request.json());
	setControlledWorkerTime(input.milliseconds);
	return Response.json({ controlledMilliseconds: input.milliseconds });
}
