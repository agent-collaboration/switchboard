import type { Config } from 'drizzle-kit';

export default {
	dialect: 'sqlite',
	schema: './packages/sign-in-core/src/storage/sign-in-schema.ts',
	out: './packages/sign-in-core/drizzle',
} satisfies Config;
