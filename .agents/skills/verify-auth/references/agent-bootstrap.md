# Declare a frozen B2 target

Return the selected journey, the complete compared target tuple, observations for its required assertions, command/exit/counts, private evidence location and every remaining gap. This reference owns shared setup and detailed driving steps.

## Establish the frozen target

Work from the repository root. On a fresh clone, install and build the frozen workspace before invoking the TypeScript runner:

```bash
mise exec node@24.7.0 -- pnpm install --frozen-lockfile
mise exec node@24.7.0 -- pnpm build
```

The runner imports the harness and its workspace dependencies before its own preparation build can execute, so their built exports must already exist.

Read `scripts/verify-auth/verify-auth.ts`, `packages/sign-in-test-support/src/test-fixtures/auth-verification-cli.ts`, `packages/sign-in-test-support/src/test-fixtures/local-auth-harness.ts` and the selected permanent host tests before running. The runner's target declaration is an owned mode0600 JSON file outside every Git checkout, with these existing fields:

```json
{"kind":"local-workerd","sourceRevision":"<full frozen checkout HEAD>","executionHost":"<machine you control>"}
```

For the sign-in Node host, write the same fields with `"kind":"local-node"`. The runner then sets `SIGN_IN_TEST_HOST=node` for both the inventory listing and the journey, and passes its `node-manifest.json` as `AUTH_PROOF_NODE_MANIFEST_FILE`.

The placeholders describe the file's shape; obtain actual values from the declared execution target. Do not print private target contents or create a second target schema. Resolve symlinks and ownership using the existing private-runtime-path validation. This file is separate from the native CLI target generated inside the harness.

Compare all of the following before treating output as an observation:

| Identity | Declared reference and actual comparison |
| --- | --- |
| Source | Full target `sourceRevision` equals `git rev-parse HEAD` in the execution checkout. Inspect tracked and untracked status: an overlay or uncommitted runtime input means the commit alone is not a frozen source identity. Freeze intended changes before proof. |
| Build/artifact | Build workspace dependencies from that frozen source with its frozen lockfile. Retain the build command, exit and artifact identities. `packages/sign-in-test-support/src/test-fixtures/proof-bundle-artifacts.ts` freezes seven Worker modules with pinned esbuild and writes `bundle-manifest.json` with each file's sha256: `productionAuth` and `productionGateway`, bundled only from `packages/sign-in-host-cloudflare/dist/index.js` and `packages/tool-host-cloudflare/dist/index.js` with no test plugin; the proof wrappers `auth` (`auth-proof-entrypoint.ts`) and `gateway` (`packages/tool-host-cloudflare/src/test-fixtures/workspace-gateway-proof-entrypoint.ts`), which import those production modules; `signingObserver`; `clock` (the Worker Date shim); and `startup`. With `AUTH_PROOF_MANIFEST_FILE` set, the harness refuses any module whose bytes differ from the declared hash. Compare `declared-target.json`, `<journey>-compared-target.json` and each `harness-<receipt>.json` identity with that manifest; stale `dist` output or an unrecorded overlay is a prerequisite gap. Source HEAD alone cannot identify an executed build. |
| Node host (`local-node` only) | `packages/sign-in-test-support/src/test-fixtures/node-proof-artifacts.ts` writes `node-manifest.json`: the built `packages/sign-in-host-node/dist/index.js`, its first-party sign-in `dist` modules, the bundled `node-management-bridge-worker.ts` and the Node configuration source, each with sha256; the harness refuses Node bytes that differ. The runner rehashes them after the run, requires one `node-harness-<receipt>.json` per Worker `harness-<receipt>.json`, each with that manifest as its identity and a non-empty initiated list, and requires every actual Node invocation receipt to equal its initiated call by invocation id. `<journey>-compared-target.json` lists `signInHost: node`, `nodeArtifacts`, `nodeReceipts` and `nodeInvocations`. A receipt attributes a call to the Node listener, records its `httpMethod` and `path` (pathname only, never query or fragment; `node-management-bridge-contracts.ts` `nodeHttpRequestIdentitySchema`) on both the initiating and the Node side, and hashes its request and response bodies; every field must match by invocation id. A receipt does not bind the query string or headers, and a bodiless request carries the empty-body hash. Behaviour beyond that comes from the test's assertions, not the receipt. The seven-module Worker manifest is still frozen and compared. |
| Configuration | Read the frozen harness's issuer construction, compatibility date/flags, D1 and named binding declarations, two Gateway heaps, three workspace configurations, trusted Tool Portal origin, resource addresses and `remembered-login` setting, and the Turnstile setting: `kind: local`, the published test site key from `packages/sign-in-test-support/src/test-fixtures/turnstile-test-keys.ts`, and `siteVerifyURLOverride` at `/__auth-proof/turnstile-siteverify` on the issuer's origin. The runner refuses any other Turnstile configuration. Compare the configuration actually passed to Miniflare (`harness-*.json` `configuration.signIn.turnstile`); on `local-node` the harness passes that same `configuration.signIn` object to the Node listener. Only loopback addresses/runtime roots may be assigned dynamically by that fixture; retain their private mapping. A different configuration needs a newly declared target. |
| Client | Read the declared target's `packages/sign-in-test-support/src/test-fixtures/local-auth-harness.ts`, `packages/sign-in-test-support/src/test-fixtures/native-cli-proof.ts`, `packages/sign-in-owner-cli/src/owner-cli.ts` and `packages/sign-in-owner-cli/src/owner-cli-login.ts`. The harness calls `loginThroughNativeOwnerCli`, which spawns the delivered `scripts/verify-auth/owner-cli.ts` entry with the fixed public code+S256 client, loopback callback, management audience, selected workspace and short private cache. Compare that executed entry and its client/redirect/audience with the frozen source; helper-only login is insufficient. Do not substitute WIP or dirty driver code. |
| Offered inventory | Collect `mise exec node@24.7.0 -- pnpm exec vitest list --project e2e-host packages/sign-in-test-support --json` on the same source. Compare offered names/files with selected runner files and the B2 journey selector, then compare the executed report's selected names/counts. Discovery is inventory only. Missing accepted cases remain gaps; they cannot disappear behind a positive count. |
| Host/toolchain | The runner checks hostname and Node24.7.0. Check pinned pnpm/toolchain and installed lockfile as well. Run real workerd/D1 proof on the machine you control; local static checks do not replace that target. |

If a driver does not yet retain enough evidence to complete a comparison, report that exact gap and do not count the run as verification. A failed prerequisite must not become a product assertion failure. Run each command on the selected machine without load admission checks or load waits. No test, helper or harness reads the real clock, waits on real time or uses a hang-guard timeout (R33): every wait ends on an event (a process exit, a readiness line, a settled promise or an explicit abort signal), and the harness's time comes from its controlled clocks. Retain harness teardown and terminal receipts. A run that never reaches its event is a harness failure to diagnose from its payload, never to cut off with a timer.

Use the target file with `pnpm verify:sign-in organization --target-file "$AUTH_VERIFY_TARGET_FILE"` or `pnpm verify:sign-in revision-fence --target-file "$AUTH_VERIFY_TARGET_FILE"`. Run each selection with each host kind and retain its compared-target JSON.
