---
name: verify-auth
description: "Verify Switchboard's passkey, organization, CLI and agent sign-in journeys on Node and workerd. Use for changes to those flows, the B2 evidence routes or a guard's sensitivity check."
---

# Verify Switchboard sign-in

The local harness serves Switchboard over HTTP on Node with SQLite or workerd with D1. It uses controlled identity providers, Turnstile, authenticators and Central. Browser cases use a fresh Playwright Chromium context, and owner CLI cases use private temporary caches.

Run from the repository root with Node 24.7.0, the pnpm version in `package.json`, and a locally available target commit containing the journey. Install the runner with `pnpm install --frozen-lockfile`. The four journey scripts check out the target in a private directory, install its locked dependencies and build it. Browser journeys install the target's pinned Chromium bundle. Agents need no browser.

The permanent tests start the harness and establish readiness with a usable JWKS, the original native CLI callback or a confirmed session and its stored effects. On a live harness, `GET /api/auth/jwks` must return 200 with a usable key.

| Journey | Run when | Entry and observations |
| --- | --- | --- |
| Passkey sign-in | The button, UV, refusal, session or audit changes | `scripts/verify-auth/passkey-sign-in.ts` · [passkey sign-in](references/passkey-sign-in.md) |
| Organizations | Choice, switching, People or checked membership reads change | `scripts/verify-auth/organizations.ts` · [organizations](references/organizations.md) |
| CLI sign-in | Bootstrap, Continue, trusted click or keyboard activation changes | `scripts/verify-auth/cli-sign-in.ts` · [CLI sign-in](references/cli-sign-in.md) |
| Agents | Registration, workspace binding or credential use changes | `scripts/verify-auth/agents.ts` · [agents](references/agents.md) |
| B2 organization and revision fence | Statement, key retention or fence behavior changes | `pnpm verify:sign-in organization` or `revision-fence` with a private `--target-file` · [organization statements](references/organization-statements.md), [revision fences](references/revision-fences.md) |
| Security checks | A guarded path, its test, oracle or driver changes | `scripts/verify-auth/security-checks.ts` · [scope and exact red/restore rule](references/security-checks.md) |
| Staging sign-in | Open until BG staging | [BG staging observations](references/staging.md) |
| Machine login | Future B3 protected-operation refusal after revocation | Open |

`pnpm verify:sign-in --commit <sha>` runs the four local journeys. Each entry accepts `--help`; a journey can run on its own with `pnpm exec tsx scripts/verify-auth/<journey>.ts --commit <sha>`. Each browser case has a named host where it uses the real HTTP harness. Input-only fixture cases use Chromium without a server.

Read the private report for the target commit and build, actual test identities and counts, verdict and assertion, applicable restore result, and the post-close snapshot of processes whose arguments identify the run. Inspect the retained logs for failures. Keep credentials, response bodies and screenshots private. Software fixtures cover local behavior. The deployed settings, real provider identity, physical authenticators and hosted limits have separate proof.
