/**
 * T15: SHA-256 of the RFC 8785 serialization of the role → Fleet permission policy
 * (`fleetPermissionPolicy` at the Better Auth boundary). Pinned so every process names its
 * loaded mapping without awaiting a hash; the policy's unit test recomputes it, so a changed
 * mapping cannot ship under this digest. A new mapping ships through the org fence's
 * stop/resume with a new digest.
 */
export const fleetPermissionPolicyDigest =
	'2d31b5d72716e64e255d8858c231f593155289fb03ed354c4b762890667a3c22';
