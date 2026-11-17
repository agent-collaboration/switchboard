# Revisions, person-fleet release and synchronization

## WS7 recovery and floor reset

Both revision and organization journeys now select `central empty:` and `central forgot:` on both storage owners, plus the `central forgot (WS7 ...)` relay host case. Follow `organization-statements.md`'s WS7 oracle: only authoritative digest `none` permits recovery; conditional clear protects newer work; all ACKs reset atomically before setup while revisions stay unchanged; current organization then person floors are delivered under the same remaining budget before retry. Normal ACK monotonicity still applies everywhere else. A lost setup reply must leave floors pending for the next use and record its unanswered counter.

The controlled peer's floor admission is component proof. Real empty-restart B2e on both pinned-central pairings is a separate required observation, including wrong-build failures without ACK reset or recovery. Keep its source, artifacts, counts and receipts separate from this journey.

## Current WS3 contract

The current contract replaces historical scheduled recovery. No Cloudflare cron triggers, scheduled handler, Node job timer or startup drain remains. Deploy and Node startup backfill stay. The after-response hint still drains; an organization's next Fleet call delivers pending revisions immediately, even inside their retry wait.

One guard budget covers stamp handling, then the organization fence, then person pairs. Q1 = A and Q2 require unavailable whenever a revision remains unacknowledged, including when renewal consumed the budget over a valid stamp. With nothing pending, D7 still permits a valid stamp's original call after a renewal timeout.

Both selectors include `fleet call:` storage cases. They prove delivery ordering and isolation, immediate on-use retry, refusal/held-request fail-closed, one budget, no double push, and wholly-unfenced write recovery versus partial-fence or failed-backfill refusal. The driver compares their separate three-module storage identity on both host selections.

R-batch adds multi-batch delivery under the same deadline, a final empty pending read before ready, a mid-batch deadline, and a pair advancing while its older ACK is recorded. An older ACK that leaves the same revision pending must keep the call unavailable. The cases keep the batch size at 100 and use 250 pairs to reject a one-batch implementation.

Counts come from each frozen inventory, not the historical counts below. Node excludes the workerd deploy-backfill case (`authorization backfill: the workerd deploy step is a server-only management method and idempotent`) and `drain: workerd has no scheduled handler, so no cron can run a drain, backfill or renewal (owner, 12 Nov)`. Both must pass on workerd. Node startup/no-interval wiring is separate source-composed integration in `sign-in-node-host.integration.test.ts`. The former cron observations listed below are superseded, not current required passes.

Run `revision-fence` after changes to atomic revision writes, person-fleet issuance/release or revision push/ACK status. Load `person-fleet-tokens.md` and `revision-push.md` with this reference: the one command now covers accepted B2 slices 2–4. Each role change/removal/session end must move its applicable retained person/organization revision in the **same database batch** as the native write. Failed writes leave both unchanged; backfill reruns add nothing and never reset an existing fence.

The deciders below are the current technical expectations for atomic native writes, retained revision pairs, monotonic ACKs, coherent synchronization reads and fail-closed release. Supporting tests and producer contracts live in this tree. Deployment and backfill-policy adoption require separate proof. Do not change these expectations to match output.

## Run on both hosts

Follow `agent-bootstrap.md`'s frozen-target setup and identity comparisons: clean source, initial frozen install/build, Node 24.7.0, pnpm 10.33.0 and private mode0600 target JSON outside Git. Check free space before builds. Use a machine you control for long or full workerd runs.

Run once with target `kind: local-workerd` and once with `kind: local-node`, with the actual frozen SHA and execution hostname:

```bash
mise exec node@24.7.0 pnpm@10.33.0 -- pnpm exec tsx scripts/verify-auth/verify-auth.ts revision-fence --target-file "$AUTH_VERIFY_TARGET_FILE"
```

The existing script's `--help` describes the command. It builds and freezes manifests, compares offered and executed names, and checks harness readiness and (on Node) every initiated/actual invocation receipt. Readiness accepts a usable public JWKS, native CLI login or verified sign-in session with a real stored row; an answering port or HTTP 200 is insufficient. Public GET `/api/auth/jwks` is the existing read-only key check.

The selector covers every `authorization fence:`, `authorization backfill:`, `authorization delivery:`, `person-fleet token:` and `drain:` case in `authorization-fence`, `person-fleet-token`, `authorization-revision-drain` and `sign-in-storage` host files, under `packages/sign-in-test-support/src/`. The storage file always runs **both** real storage legs, whatever the HTTP-host target.

Counts and host-specific exclusions come from the frozen offered inventory and `declared-target.json`, never historical counts. Every selected case must pass; workerd-only cases are not Node passes. Node startup ordering and absence of interval/startup-drain callers are checked separately by `packages/sign-in-host-node/src/sign-in-node-host.integration.test.ts`. Retain unrelated filtered tests and host exclusions separately.

## Deciders and source boundaries

| Action and real readback | What must be true | Wrong behavior rejected |
| --- | --- | --- |
| Native add, role update, removal, rejoin, leave; SELECT native member and retained pair | Same pair ID, revisions 1→2→3→4→5; removed/left inactive, rejoined active; unrelated persons unchanged | after-hook-only bump, lost subject identity, changed role without revision |
| Native single/bulk session deletion and sign-out; SELECT sessions and every retained pair | Session gone and each pair bumped while preserving active/inactive state; member rows unchanged | only active memberships bumped, sign-out acknowledged without database effect |
| Duplicate native PK, missing retained row, overflow and failed native operation; compare whole before/after snapshots | Native rows and every fence roll back together; sign-out may return 200 despite deletion failure, so row comparison decides | revision commits before native write, missing pair repaired/reset silently, HTTP success mistaken for committed sign-out |
| Zero-row/equal-role writes; controlled overlapping guarded role updates | No invented bump; only one guarded update moves the pair, with holds ending on explicit events | stale pre-read predicate, duplicate bumps, sleeps hiding a race |
| Populated pre-fence store; backfill, rerun, overlapping backfills | Missing rows get initial active revision 1 and injected UUIDv7 pair IDs; rerun reports zero additions and leaves advanced/inactive/stopped/deleted rows identical; concurrent runs converge | resetting existing rows, duplicate pair, allowing unfenced native mutation |
| Delivered production organization create/invite/accept/remove routes | Creation writes org/creator fences, acceptance writes the member pair, removal retains/bump-inactivates it and leaves owner untouched | fixture adapter works while the production provider still uses stock Drizzle |
| Dual-storage release-fence session cleanup and unbound-person cleanup | Actual production stores bump all retained pairs, including removed orgs; missing pair leaves session; unbound cleanup bumps/inactivates retained pairs and preserves a bound person | cleanup bypasses fenced mutation, deletes session/person without revisions |

Read `authorization-fence-proof.ts`: most native scenarios use a **fixture-composed Better Auth provider over the production fenced adapter** and real injected store, opening native routes the production allowlist closes. Direct adapter operations are reached through that fixture. The explicit production-organization-route case catches missing wiring in `provider-configuration.ts`; the wrapper cases alone cannot. The dual-store cases directly call production store APIs, rather than a public sign-out page. Name these layers separately.

The production provider chooses `authorizationFencedAdapter`; its member/organization/session DML goes through `createAuthorizationFenceMutations` → injected `runAtomically` fixed statements. Backfill uses injected Drizzle, IDs and clock and insert-or-ignore statements. Time in tests is controlled; overlap uses entered/release promises. Do not add wall-clock waits. Central is outside this journey: no actual central floor application, ACK-after-commit, admission, browser or hosted identity claim follows from these rows. The source's push/ACK handling is now observed against its named recording peer as `revision-push.md` describes. The first-membership/session-end race and ACK/status interleavings are covered by the added slice-3/4 cases; actual central admission remains separate.

The `people` journey retains its separate intent/outcome fault cases, including after-hook failure after a native fence batch committed. The focused revision command does not claim the entire accepted correction or full host suite.

## Evidence and cleanup

Keep command/exit/counts, offered inventory, selected names, Vitest JSON, runtime/case/phase logs, artifact manifests, declared/compared target and readiness receipts. `revision-fence-compared-target.json` records `revisionEvidence`; every local-auth harness must have one `revision-evidence-<receiptId>.json` matching its `harness-<receiptId>.json`.

Exports are private mode0600 final database snapshots: member rows, session **IDs/user IDs only**, organization revision rows and person/organization revision rows, plus the recording peer's parsed push-arrival sequence and exact push request/reply bodies. No session tokens, cookies, client secrets or signing private keys are exported. Final snapshots supplement direct intermediate assertions; they cannot reconstruct a failed/held operation's earlier state. Dual-storage cases keep their literal expected readbacks in the permanent assertions and Vitest result; they do not use the local-auth exporter or readiness receipt. Preserve their runtime roots as provided by that fixture.

Inspect exports and manifests after cleanup, and require exact selected pass agreement; neither HTTP success nor a revision count alone passes. Retain historical wrong-build red/restored evidence with its source limits when applicable. Without a mutation grant, do not edit product code to produce a red; name fresh sensitivity unobserved.

The existing harness/process runner closes only its own processes/listeners and fails remaining process-group members. Preserve evidence until consumers finish. A prerequisite or stalled harness is not a product assertion failure. Stop only recorded owned IDs; leave other agents' state alone.
