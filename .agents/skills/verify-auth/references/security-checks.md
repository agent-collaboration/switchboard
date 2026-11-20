# Security checks that can fail

The adopted design IDs below refer to owner-held design documents that are not shipped in this repository. The expected behavior stated here is the authoritative public statement for this recipe. Public package contracts are linked where available.

Adopted outcomes: B1-B S5/S8/S12 and PR8 F1/V5/V6 require active membership before session creation, separate outer/provider rate refusal and the failed sign-in audit. B1-C S3–S10/S13 require no factor restamp on switch, live owner permission before and after a scoped read, exact public projections, unavailable answers for malformed storage, closed native roster routes and stale-reply refusal. `verification/security-checks.ts` records each qualified exact edit and expected assertion; permanent tests observe those rules rather than define them. `qualified-edits.json` carries the copied patch bytes.

Run `pnpm exec tsx scripts/verify-auth/security-checks.ts --commit <sha>` at public main `7e32e00e993af5ecfcdb8ce366c5f0dea47bf335` or a descendant. All fourteen controls share that baseline; `--checks F1` selects a focused control when needed. The aggregate alias defaults to all four journeys plus all fourteen controls. Missing ancestry, target files or changed patch/assertion sites fail; none is silently omitted.

1. For each selected check, create a separate temporary checkout, install frozen dependencies and capture the original source state.
2. Apply only the checked-in exact edit; zero or multiple matches fail. F1 uses the qualified B2 catch-path edit: only the failed-passkey audit write becomes an empty awaited allSettled call; B1-C routes, cleanup and scheduling stay intact.
3. Build and run the named test(s) on both hosts. The expected count must fail with exactly one error per selected case carrying both the expected assertion text and the exact checkout-relative matcher stack location; setup errors, a different assertion, a signal or zero tests do not count as a successful red.
4. Restore original bytes and check the entire tracked diff plus untracked source. Rebuild and run the same selection green on both hosts.
5. Report each red/green, source restoration and any owned-process leak/unknown cleanup. Restore also runs on a failed attempt.

Gotchas: HTTP15 intentionally changes two files together because the strict parser otherwise blocks leaked native fields. Provider and outer limiter controls are separate. The passkey exact workerd window is a declared stand-in; the separate permanent real-binding case retains its own scope. Stale-reply's direct state-machine assertion is not a real-Chrome publication claim. A deliberately broken commit must make the script exit nonzero, independently of the expected security reds.

Raw logs remain private on failure. The safe JSON contains no cookies, tokens, keys or provider response bodies. The driver does not change CI or the invoking checkout and never touches Keychain.

Public contracts: [sign-in core](../../../../packages/sign-in-core/README.md) and [owner CLI](../../../../packages/sign-in-owner-cli/README.md#fleet-commands).
