---
name: verify-auth
description: "Verify Switchboard's passkey, organization, CLI and agent sign-in journeys on Node and workerd, or run their checked-in security checks. Use after changes to those flows."
---

# Verify Switchboard sign-in

Switchboard's sign-in service runs on Node with SQLite and on Cloudflare workerd with D1. Its local harness starts the real host and storage; Google/GitHub, Turnstile siteverify, authenticators and Central replies are controlled fixtures. The browser journeys drive an isolated real Chrome profile. They never touch Keychain or an open user browser.

Install the script checkout with `pnpm install --frozen-lockfile`. Use Node24+ and the pnpm version in `package.json`. Set `CHROME_BIN` to an existing Chrome executable, or put `google-chrome` on PATH. The script reports its version without requiring a fixed version. Run scripts from the repository root with a locally available commit.

Each script makes a fresh temporary checkout, installs its frozen lockfile and builds. The permanent tests own their harness startup/readiness: real usable JWKS or a native callback/session and the subsequent asserted effects. An open port is not readiness. On an already running harness, `GET /api/auth/jwks` is the read-only health check: it must return200 with a usable published key. A journey passes when its selected tests pass on that target.

| Journey | When and why | Script / reference |
| --- | --- | --- |
| Passkey sign-in | Button, user-verification, refusal, session or audit changes | `scripts/verify-auth/passkey-sign-in.ts` · [journey](references/passkey-sign-in.md) |
| Organizations | Choice, switching, People or checked membership reads | `scripts/verify-auth/organizations.ts` · [journey](references/organizations.md) |
| CLI sign-in | Bootstrap, Continue, keyboard or click behavior | `scripts/verify-auth/cli-sign-in.ts` · [journey](references/cli-sign-in.md) |
| Agents | Owner registration and workspace-bound credentials | `scripts/verify-auth/agents.ts` · [journey](references/agents.md) |
| Security checks | Prove the guards' permanent tests detect the checked-in deliberate breaks | `scripts/verify-auth/security-checks.ts` · [checks](references/security-checks.md) |
| Machine login | Future, after B3 lands | No script or proof yet |

Each script's `--help` explains its behavior, inputs and invocation. `pnpm verify:sign-in --commit <sha>` runs all four journeys and all fourteen security checks. Public main `7e32e00e993af5ecfcdb8ce366c5f0dea47bf335` or a descendant is the shared capability baseline in `verification/target-baseline.ts`. Missing capability or an older target fails rather than becoming a passing skip. `--checks none` runs only the journeys; the security-checks entry runs only the controls. CI's full suite remains separate.

The terminal table and private JSON report contain the five deciding facts: commit, actual tests/counts, result/assertion, exact restore for security checks, and owned work left running. Unknown cleanup fails. A late exit qualifies only when bounded group reads become empty without an adapter signal; required SIGTERM remains a failure. Raw logs stay private on failure and are removed on success; the JSON report survives. Never publish cookies, tokens, recovery codes, profile screenshots or private database bodies. Software fixtures do not prove live identity, a physical authenticator, hosted counters or staging.

The scripts stop only their own process groups, restore each security edit, and remove successful temporary checkouts. Failed checkouts/logs remain with the report for diagnosis. Classify a failure before changing anything: stale instructions, a broken driver, a product regression against the adopted source, or unknown cause. Repair only the skill/driver; keep the expected outcome when the app regresses.
