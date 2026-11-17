# Revision push, ACK and synced/pending

## WS3 supersedes the scheduler and retry observations below

No scheduled caller remains. After-response hints still run `runAuthorizationRevisionDrain`; each organization goes through one guard that handles its stamp and revisions without recursion or double push. The on-use guard bypasses the old retry schedule, delivering the organization fence before person pairs. A hint may still honor retry time; a Fleet call must not. Q1/Q2 fail closed if any revision remains unacknowledged at the shared deadline, even over a valid stamp. The former cron-entry and periodic-retry rows below are historical.

Observe `fleet call:` on both actual storage owners, the updated `drain:` HTTP cases, the no-scheduled-handler case on workerd, and the source-composed Node integration for no interval/startup drain. The separate real-central B2e revoked-token case observes the relay delivering revocation before central refuses the old credential. Final row exports and component assertions retain their distinct evidence layers.

The `revision-fence` command checks the sender/store expectations below. Both hosts run against `controlled-central-provisioning.ts`, a **recording producer-contract peer**. Its in-memory floors/ACK replies are a stand-in, not real central floor storage, ACK-after-commit, transaction durability, provisioning readiness or admission.

## What the command observes

`authorization-revision-drain.host.e2e.test.ts` drives production create/invite/accept/remove routes and the real private host transport. A response hint's work is awaited through `settleDeferredWork`, never time. No periodic caller remains; after-response hints and on-use guards invoke the drain. Node startup/timer wiring belongs to the existing `packages/sign-in-host-node/src/sign-in-node-host.integration.test.ts` and must not be inferred from this host file.

| Drive | Readback and expected result | Wrong behavior rejected |
| --- | --- | --- |
| Native setup | Recorded organization push precedes person pushes; actual organization/person ACK columns reach current revision | person sent before its floor, ACK omitted or invented |
| Native removal with no cron/timer | After-response hint alone sends the exact removed subject ID/revision/inactive state; real ACK row advances; status reads `synced` | hint never drains, wrong subject/version, response shown synced before ACK |
| Peer applies then loses ACK | The pair stays pending until a later hint or on-use guard receives and records the current ACK | lost reply treated as confirmation, pending revision ignored |
| Peer loses organization floor | Person push gets412, sender resends organization then person; source organization ACK never regresses | stale local ACK prevents resend, person accepted without required floor |
| No scheduled caller | Workerd exports no scheduled handler; Node registers no periodic drain | a removed scheduler still dispatches work |

The `sign-in-storage.host.e2e.test.ts` selector also includes all four `authorization delivery:` definitions on **each** actual D1/workerd and SQLite leg:

- ACK N while current N+1 records only an allowed monotonic ACK and leaves pending; older/above-current ACKs never invent confirmation.
- A stale defer cannot delay a newer version; equality at retry time is eligible.
- `personInOrganization`, `personEverywhere` and organization status are `synced` only when every required retained pair **and its organization floor** is ACKed at its current revision. Missing/unknown/lagging rows remain `pending`; inactive retained pairs still count.
- A controlled real writer bumps an ACKed pair and ACKs the lagging organization between logical reads. No state was ever fully synced; the production single-snapshot read must return `pending`. A split-read implementation fails this interleaving.

The status control `/__auth-proof/authorization-sync` is a proof-only read of the production store, not an already delivered people-page/public route. Host source path: after-response hint / on-use guard → `runAuthorizationRevisionDrain` → pending rows (bounded pass, organizations first) → real host central transport → recording peer → conditional ACK/defer write → production synchronization read. Capture waits are event-based. No product scheduler, clock or IDs are replaced with wall-clock sleeps.

## Evidence and limits

The common revision exports now include `centralPushes` (parsed arrival order) and `centralExchanges` (accepted exact UTF-8 request body, fixed route, response status/body or lost-reply marker), alongside real retained revision/ACK rows. Compare subject/organization/revision/state and reply values against the permanent assertions. Raw replies model only the producer contract; their presence is not proof of real central commitment.

Exports run inside the existing close capture phase, after pending-at-close and Node receipt snapshots. A pending forwarder remains a failure even if it finishes during export; export failure still cleans up. Final multi-query row dumps are not the coherent synchronization read and cannot reconstruct every intermediate state. The dedicated interleaving assertions decide that property.

Keep the matched source/artifact/host/client tuple, both host reports, raw wire/row files and cleanup receipts after teardown. Supporting bound units are reported separately, not counted as push/ACK host cases. Central floor application/replay/admission and an actual globally revoked UI remain outside this journey until their real interaction is accepted and driven.
