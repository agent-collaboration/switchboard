# Choose an organization and read People

Expected result: B1-C Specification S1–S10 and S13, with HTTP9–16/B04/stale-generation controls. A person reads only their memberships and can switch a valid organization repeatedly while CLI Continue still works. Switching uses native set-active and never confirms or extends a second factor. Owner-only reads check live session and permission before and after data access, release only the requested organization's projection, and never publish an older request's reply over the current one. Native private roster routes stay closed.

Requires public main `7e32e00e993af5ecfcdb8ce366c5f0dea47bf335` or a descendant, containing the adopted organization capability. The commit must already be available locally. Run `pnpm exec tsx scripts/verify-auth/organizations.ts --commit <sha>`.

1. Build a fresh checkout and run the real-Chrome organization browser file on each host. The chooser switches twice, returns to the original native CLI and reads back refused/lost replies; People keeps the latest lookup and list page.
2. Run people-organizations, people-membership-lookup, people-organization-list and people-organization-context. Observe native organization/member rows, exact projection, both permission fences and unchanged factor facts.
3. Report the actual test results and cleanup; no browser or setup failure is silently skipped.

Failures that matter: cross-organization facts, a removed/ended owner reading held results, renewal of an old confirmation by switching, stale reply publication or missing CLI continuation. The security script runs HTTP09–HTTP16, B04 and stale-reply separately against the same target.

Gotchas: test fixtures control social/Turnstile/authenticator/Central services. A browser or passkey hang remains a failed journey; do not shorten the journey to match the app. B2 stamp renewal/revision component expectations are supplementary sources, not proof granted by this B1-C journey.
