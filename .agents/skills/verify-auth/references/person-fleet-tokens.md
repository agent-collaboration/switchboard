# Person-fleet token release: the accepted layers

The `revision-fence` command in `revision-fences.md` now includes person-fleet issuance, refusal and race cases on both actual HTTP hosts. The required layers are **real host cases for native issuance, refusals and races; pure release vectors and outer-release composition units for isolated deadlines**.

Native Better Auth samples `iat` before the contributor captures S. Consequently native `exp ≤ S+L` at this issuer; the real held `S+L` case also reaches native expiry. It does not isolate snapshot expiry while native expiry stays future. Report that limitation explicitly. Do not invent a synthetic host token or claim the unit vectors are live host observations.

## Drive and deciders

Use the common frozen target/command from `revision-fences.md` on `local-workerd` and `local-node`. The selected permanent file is `packages/sign-in-test-support/src/person-fleet-token.host.e2e.test.ts`: use its frozen offered inventory for current counts.

| Action | Deciding observation | Wrong behavior rejected |
| --- | --- | --- |
| Native S256 authorization/code exchange for the admin audience, with a real caller DPoP key | Actually signed token verifies against public JWKS; `token_type` is DPoP; `cnf.jkt` equals the independently derived key thumbprint; exact owner permissions, stored subject/revisions, loaded policy digest, original factor/session facts and `S+300000` match real row reads; native `iat/exp` stay native | missing key binding, claims dated after the snapshot, wrong subject/revisions, invented fresh factor |
| Member or missing authority | Member receives no Fleet permissions; missing proof, old policy, removed pair or stopped organization returns its exact credential-free refusal | cached role/policy, an inactive subject admitted, a credential hidden in an error body |
| Management audience | Genuine owner management token carries no Fleet profile/permissions | Fleet claims leaking into a different token kind |
| Snapshot read held to S+L | Real outer release refuses with no credential, at equality; native expiry is also reached in this host case | returned signed token after the fixed application/native deadline |
| Session deletion held while a first membership is created | Real fixed batch sees the new retained pair and bumps every applicable pair; held issuance never releases after the session ends | pre-dispatch membership snapshot omits a new pair, signed response released after deletion |
| Session gone before exchange | Native code cannot mint and returns a credential-free native refusal | remembered code/session treated as fresh authority |

The proof-only admin-client setup registers the fixed audience/resource with the real native provider. Positive credentials come through the delivered authorization/token handlers, not a fixture signer. Google/sign-in session fixtures remain controlled. Source path: native token contributor → `personFleetAccessTokenClaims` samples S before one coherent primary read → `decidePersonFleetIssuance` → native signing → outer `releaseSignInResponse` / `decidePersonFleetRelease` → fresh live person/organization/session check before release. The test's clock/hold headers only control timing at an existing proof boundary.

## Supporting units and evidence

The runner discovers and executes the four complete unit files before the real host observations:

- `packages/sign-in-core/src/better-auth/person-fleet-token-claims.unit.test.ts`: S is captured before a deliberately slow coherent-read port returns; the deadline is never redated. This is a controlled unit port, not a database latency measurement.
- `packages/sign-in-core/src/organizations/person-fleet-issuance.unit.test.ts`: exact snapshot claims, original factor time, member permissions, refused authority/policy/window cases.
- `packages/sign-in-core/src/response-release/person-fleet-release.unit.test.ts`: each snapshot/session/native deadline at equality, the same claims 1 ms earlier, invalid profile/window cases. Claims are vectors, not native signatures.
- `packages/sign-in-test-support/src/core-tests/sign-in-response-release.unit.test.ts`: outer response-release composition and credential-free refusal. These are process-local ports/composition, not either live host.

Keep `supporting-unit-inventory.json`, `supporting-unit-vitest.json`, `supporting-unit-runtime.log` and `supporting-unit-process.json`; their offered file/name set must match all passing executed observations, with zero failed/pending units. Counts are separate in the host summary/compared target. Keep the main host report, actual native-key/JWKS assertions, readiness/Node attribution receipts and revision row exports as the common recipe requires. The driver does not export Person credentials or the caller private key.

Native token signatures/row matches prove issuer behavior, not central's later admission of that token. Actual central bounds, floors, replay/DPoP checks and persisted admission remain unverified by this component journey. Raw per-step signed tokens and coherent-read internals are not exported; use the permanent literal assertions and retained private runtime state, not final rows alone, for the observation.
