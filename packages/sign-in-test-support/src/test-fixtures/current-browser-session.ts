import { session, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { getSessionCookie } from 'better-auth/cookies';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const browserSessionSchema = z.object({
	id: z.uuidv7(),
	personId: z.uuidv7(),
	secondFactorAt: z.number().int().nonnegative().nullable(),
	secondFactorMethod: z.string().nullable(),
});

/** Read the row matching the cookie actually returned to this local browser.
 * The cookie comes from the real handler; this helper creates no identity or context. */
export async function readCurrentBrowserSession(props: {
	readonly cookie: string;
	readonly database: SignInDatabase;
}): Promise<z.infer<typeof browserSessionSchema>> {
	const signed = getSessionCookie(new Headers({ cookie: props.cookie }));
	if (signed === null) throw new Error('Real browser has no session cookie');
	const value = decodeURIComponent(signed);
	const separator = value.lastIndexOf('.');
	if (separator <= 0) throw new Error('Real browser has no signed session token');
	const rows = await props.database
		.select({
			id: session.id,
			personId: session.userId,
			secondFactorAt: session.secondFactorAt,
			secondFactorMethod: session.secondFactorMethod,
		})
		.from(session)
		.where(eq(session.token, value.slice(0, separator)));
	const current = z.array(browserSessionSchema).length(1).parse(rows)[0];
	if (current === undefined) throw new Error('Real browser session absent');
	return current;
}
