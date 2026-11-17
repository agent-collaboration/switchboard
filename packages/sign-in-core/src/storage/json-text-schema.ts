import { z } from 'zod';

/** Better Auth's SQLite adapter serializes JSON; the store validates one decoded value. */
export function jsonTextSchema<TValue>(schema: z.ZodType<TValue>): z.ZodType<TValue> {
	return z
		.string()
		.transform((value, context): unknown => {
			try {
				const decoded: unknown = JSON.parse(value);
				return decoded;
			} catch {
				context.addIssue({ code: 'custom', message: 'Stored JSON text is invalid' });
				return z.NEVER;
			}
		})
		.pipe(schema);
}
