# Passkey sign-in

Expected result: B1-B Specification S1–S12 / Verification V1–V9, especially S5 membership before session creation, S8 per-layer limits, S9 no unconfirmed release and S12 audit. Only a registered, user-verified passkey for an active person may create a session; a refused or unconfirmed attempt releases no cookie or credential. Admitted attempts retain their required audit outcome. The [public core contract](../../../../packages/sign-in-core/README.md) also documents click-only passkey sign-in, copied factor facts and separate rate-limit layers.

A person loads the public sign-in page without creating a challenge, clicks Continue with Passkey, completes user verification and returns signed in. A no-UV, unknown-credential, removed-member or post-INSERT fault leaves them signed out; admitted attempts record the required outcome. Rate-limited requests create nothing.

Prerequisites: the adopted main commit `7e32e00e993af5ecfcdb8ce366c5f0dea47bf335` or a descendant, existing Chrome, pinned pnpm and build prerequisites. Run `pnpm exec tsx scripts/verify-auth/passkey-sign-in.ts --commit <sha>`.

1. The script builds a fresh target and runs `sign-in-native-browser.host.e2e.test.ts` once per named host, selecting its actual host parameter. Observe the delivered Chrome button, registration, no-UV refusal, CLI continuation and script-failure behavior.
2. It runs `people-passkey-sign-in.host.e2e.test.ts` on each host. Observe native storage, INSERT, cookie absence, factor stamp, replay and audit assertions. These HTTP/software-authenticator cases remain distinct from Chrome proof.
3. The report names actual passing/failing tests and any owned-process cleanup failure.

Failures that matter: accepting no UV, new session INSERT for a removed person, missing failed audit, body credentials, fallback404 or stale controller response. Setup/import/browser startup failures are driver/prerequisite failures, not security reds. The separate security script tests V5/F1/V6 sensitivity.

Gotchas: a challenge-only test has no authenticated readiness; it still belongs in this standalone journey. Controlled Turnstile and a virtual/software authenticator do not prove live-provider or hardware acceptance. Raw failure logs/images are private.
