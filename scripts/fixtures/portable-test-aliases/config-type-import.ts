import type { createOAuthPolicyCompilerTestInput } from '@agent-collaboration/config-contracts-test-support/oauth-policy-compiler-test-fixture.js';

export const forbiddenConfigDependency = null satisfies ReturnType<
	typeof createOAuthPolicyCompilerTestInput
> | null;
