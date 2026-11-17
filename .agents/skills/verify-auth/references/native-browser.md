# Native sign-in browser journey

The browser proof requires: the actual browser page must drive native enrollment, refusal, confirmation, organization creation, recovery-code replacement and token-redacted session reads. The test lives beside the sign-in host e2e tests and is discovered by the existing `e2e-host` project. The taxonomy audit and workflow need no special exemption.

## Prerequisites and command

Use the frozen checkout containing the sign-in UI. Build it with the repository's pinned tools before running the host lane. Chrome must be available as `google-chrome` on PATH, or `CHROME_BIN` must name the existing executable. The launcher uses a fresh private profile and dynamic loopback DevTools port. It never uses an open user browser, installs Chrome, changes the workflow, or disables Chrome's sandbox. A missing executable or startup refusal is a prerequisite failure, not a skipped passing test; report it before proposing environment or workflow changes.

From the monorepo root, with the selected Chrome already in the environment:

```bash
mise exec node@24.7.0 pnpm@10.33.0 -- pnpm build
mise exec node@24.7.0 pnpm@10.33.0 -- pnpm test:e2e:host
```

For a focused development run, the same standard project can select the file:

```bash
mise exec node@24.7.0 pnpm@10.33.0 -- pnpm exec vitest run --config vitest.config.ts --project e2e-host packages/sign-in-test-support/src/sign-in-native-browser.host.e2e.test.ts
```

The required full host lane still applies. Both cases run sequentially in this file: Node/better-sqlite3 and workerd/D1. No private target JSON, machine-specific checkout or separate configuration is required. The fixture imports its own checkout's harness directly and compares browser-served CSS/island bytes with the built inputs embedded by sign-in-core. Keep the build/source revision, actual tools, offered cases and execution receipts when reporting a frozen observation.

## Observations

The permanent assertions require these outcomes on each host:

- The sign-in page includes the published Turnstile test key and script. A controlled provider callback establishes a native cookie session and reaches the authenticated owner enrollment UI.
- Native enrollment returns an authenticator URI naming Switchboard. A software authenticator learns only that response in memory, generates a valid TOTP, and the explicit saved-codes Finish reaches organization-create.
- After the existing clock seam advances beyond the confirmation window, the organization form is hidden. A code excluded from the valid time window is refused with Better Auth’s “Invalid code” inline and exactly one toast; a valid code confirms and reaches the organization form.
- The real organization form succeeds and shows account/Security. Replacement returns new recovery codes with none reused and mounts Copy, Download, Print and Finish in the written page. Finish returns to account.
- Native get-session returns a session id and no recursively present token key.

The software authenticator and native hosts share `controlled-sign-in-time.ts`; only Date is faked, leaving protocol bounds real. Page navigation is armed before navigating actions, and the DOM predicate is evaluated in the new document. Never replay the product action or weaken a predicate to clear a driver failure.

## Evidence and cleanup

Each case prints one `native-browser-evidence` record naming its private OS-temp directory. It retains steps/observation JSON, browser version, endpoint statuses, CSS/island identities, frozen proof manifests, Node invocation pairs, teardown phases and error/finish PNGs. Compare all initiated/actual Node invocation records and artifact hashes before counting Node proof. Bootstrap harness readiness can remain false on this direct browser route; the native authenticated UI and subsequent native effects are this journey's witness, not a synthetic bootstrap pass.

Screenshots are private: an early failure can show the authenticator setup URI, QR or recovery codes. Never publish those, cookies, raw credential-bearing responses or the Chrome profile. Retain failures and selected pass/fail counts distinctly; a setup failure is not product sensitivity evidence. Browser console error counts are not attribution or a clean-console claim.

The fixture closes only its own Chrome and native harness, restores its process environment and leaves evidence intact. Confirm teardown receipts and owned process cleanup without stopping another session's listener. Preserve needed evidence until its consumers finish before removing this run's temporary residue under repository cleanup rules.

Controlled provider and Turnstile siteverify, software authenticator, injected clock and central provisioning model remain explicit stand-ins. The path does not establish real Google/GitHub or Cloudflare challenge acceptance, a physical authenticator/passkey, hosted deployment, central acceptance, OS clipboard/download/print effects or paper output. Print-media behavior has its separate proof; this journey asserts the Print control's presence and replacement Finish.
