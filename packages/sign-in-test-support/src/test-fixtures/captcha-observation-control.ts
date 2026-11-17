import { uuid7Schema } from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

export const captchaObservationDrainPath = '/__auth-proof/captcha-log-drain';
export const captchaObservationDrainSchema = z.strictObject({
	kind: z.literal('captcha-observation-drained'),
	requestId: uuid7Schema,
});

/** A test-wrapper stream marker, never a production route or observation. */
export function handleCaptchaObservationDrain(request: Request): Response | null {
	const url = new URL(request.url);
	if (url.pathname !== captchaObservationDrainPath) return null;
	const requestId = uuid7Schema.safeParse(url.searchParams.get('request_id'));
	if (!requestId.success) return Response.json({ error: 'invalid-drain-request' }, { status: 400 });
	console.log(JSON.stringify({ kind: 'captcha-observation-drained', requestId: requestId.data }));
	return Response.json({ kind: 'complete' });
}
