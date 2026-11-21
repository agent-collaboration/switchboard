import * as hegel from '@hegeldev/hegel';
import { z } from 'zod';

/** Printed alongside the shrunk draw so a finding can be rerun without a Hegel database. */
export const fuzzSeed = z.coerce
	.number()
	.int()
	.safe()
	.parse(process.env.SIGN_IN_FUZZ_SEED ?? 20261117);

export function fuzzSettings(defaultCases: number): Partial<hegel.Settings> {
	return {
		testCases: z.coerce
			.number()
			.int()
			.positive()
			.parse(process.env.SIGN_IN_FUZZ_CASES ?? defaultCases),
		seed: fuzzSeed,
		derandomize: true,
		database: hegel.Database.disabled,
	};
}
