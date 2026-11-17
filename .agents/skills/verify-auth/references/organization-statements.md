# Organization statements and renewal on use

## WS7: recover an emptied central

R-retrysignal additionally requires the retry deadline to reach the actual admin-client Request. Both selectors include `R-retrysignal (forwarding):` in `organization-admin` and `R-retrysignal (relay):` in `fleet-admin-relay`. At the transport entry, after firing the same deadline on the retry's arrival, require the first Request still not aborted, the retry aborted with TimeoutError, and equal body bytes. Dropping the signal at either caller or inside the client must produce an assertion failure. Node also waits for the held Unix peer to observe its connection close. Workerd observes the actual Request before the service binding; native binding abort propagation remains unverified. The deadline barrier must trigger independently of whether the signal was supplied, so a missing signal cannot prevent the observation from completing.

Recovery requires recovery only after an authoritative digest `none`. An original admin HTTP 503 or a revision push answered HTTP 503 triggers that probe within the remaining D7 budget. A transport failure, another status, a current stamp, unavailable read or timeout never establishes emptiness. The first original call remains unbounded by the guard deadline; recovery and its one retry use the remaining budget, with no third dispatch.

After `none`, a conditional clear must preserve newer confirmed or sent work. The run that owns the clear resets the organization and every person ACK to zero in one atomic store write, before setup. Revisions stay unchanged. It sends a fresh setup with no `replaces`, seeds central's actual facts after confirmation, then delivers the current organization floor before person floors through R-batch. A deadline leaves pending floors for the next use. This recovery is the sole ACK-lowering exception.

Recovery setup has no sent slot: a lost reply leaves digest and sent null, records one unanswered try and its actual reason in the latest try, and permits fresh idempotent setup on next use. A deadline records `unanswered-timeout`; a generic transport loss records `unanswered-unavailable`. Observe both reasons on both storage legs. This explicit exception does not weaken renewal's byte-identical pending requirement. The setup-applied/reply-lost case checks that the next use still delivers floors. Both storage legs also check unchanged original refusals, shared-budget exhaustion, push-503 recovery, and stale `none` interleaved with newer confirmed or sent work.

Both journeys select `central empty:`, `central forgot:` and the `central forgot (WS7 ...)` relay host case. The relay uses the actual host transport but a controlled peer; its opt-in bare unstamped 503 and floor admission remain stand-ins. B2e separately requires not-due first-use and pending-push recovery after real pinned central `e847a888` restarts with a fresh Tokio root or unused workerd namespaces, on both pairings. Require the exact link sequence, central's fresh no-predecessor stamp and floor state, sign-in's matching stamp and ACKs, and sensitivity failures without recovery or ACK reset. Until those runtime receipts exist, integrated recovery remains unverified.

The retry deadline case must hold the post-recovery admin retry forever, ignore abort and fire the same manual deadline on arrival. Require the actual caller answer `unknown:timeout`, two peer arrivals with no third, current floors and one 5-second budget. Keep the first-original-call-after-budget positive. A peer ledger alone cannot prove what the caller returned. The no-retry-race control currently produces workerd's hung-request cancellation and a 20-second SQLite test watchdog; that is hang sensitivity, not an assertion-level red.

## WS3: one guard for stamps and pending revisions

The current contract supersedes historical scheduled recovery: Both crons, the scheduled handler and all Node job timers/startup drain are removed; deploy and Node startup backfill stay. After-response hints remain. Before an original Fleet call, one guard budget covers stamp handling then pending organization/person revisions, in that order, ignoring retry time on use.

Q1/Q2 require unavailable if revisions remain unacknowledged, including when renewal spent the deadline over a valid stamp. D7's valid-stamp continuation holds with nothing pending; the new relay case proves that path, while the revised renewal/drain case proves Q2.

The organization selector includes all `fleet call:` storage cases, all `drain:` host cases, and the held-renewal relay case. It retains the separate storage identity. Check both storage owners for ordering/isolation, immediate retry, refused/held push, shared budget, no double push, and wholly-unfenced write recovery versus partial-fence/failing-backfill refusal. Revision-fence supplies the native write/backfill observations; separately pinned B2e supplies real central ordering/revocation. Current counts come from the offered inventory.

R-batch requires more than one batch: the guard retains the 100-row read limit, repeats delivery inside the same deadline, and returns ready only after a fresh read finds no pending rows. The permanent cases cover 250 pairs, a held push in a later batch, a pair advancing while its older ACK is recorded, and an older ACK that leaves the row pending without an endless re-push. Empty pending state still permits a valid stamp's original call after renewal spent the budget; the deadline check must not erase that D7 path.

Run `organization` to observe native organization creation, renewal before Fleet use and the persisted stamp record. A stamp lasts 120 days; a Fleet call renews it with 60 days or less left. An unanswered statement is re-sent byte-identical. Run on **both** `local-workerd` and `local-node`.

Central is a recording stand-in. These observations do not prove central's signature acceptance, compare-and-swap, authoritative digest source, retained old key, cold restart, isolation or persisted admission. Later B2 slices, BG setup, B3 device grant and hosted/browser behavior need separate journeys.

## Prepare and run

Use `agent-bootstrap.md`'s **Establish the frozen target** procedure: clean source, initial frozen install/build, private mode0600 target file and complete target tuple. Its source/artifact/configuration/client/inventory/host checks apply unchanged. Check free disk space before builds and run long or full workerd proofs on a machine you control.

The existing target JSON is `{kind, sourceRevision, executionHost}`. Set `kind` to `local-workerd` for sign-in on workerd+D1, then `local-node` for the built Node listener+better-sqlite3. Use a separate target file/run for each. Do not share a running instance between agents.

From the repository root, with `AUTH_VERIFY_TARGET_FILE` naming that private declaration:

```bash
mise exec node@24.7.0 pnpm@10.33.0 -- pnpm exec tsx scripts/verify-auth/verify-auth.ts --help
mise exec node@24.7.0 pnpm@10.33.0 -- pnpm exec tsx scripts/verify-auth/verify-auth.ts organization --target-file "$AUTH_VERIFY_TARGET_FILE"
```

Node 24.7.0 and pnpm 10.33.0 are required. The runner installs the frozen lockfile, builds, freezes executable Worker bytes and Node artifacts, discovers inventory and runs the permanent cases. It waits on events and injected clocks. Do not advance expiry or terminate stalled cases with wall-clock sleeps/timeouts.

Readiness is a retained `harness-*.json` with `ready: true` and `jwks`, `personToken` or `signInSession`. A JWKS witness means the real public endpoint returned a usable key; `signInSession` includes a matching verified session row. A port or status alone is insufficient. Public GET `/api/auth/jwks` is the read-only key health check used by the stamp cases.

The frozen inventory selects `organization stamp:`, `organization renewal:`, `renewal on use:` and `key change:` cases; the expired-stamp cases in `organization-admin` and `fleet-admin-relay`; and the `people:` cases in `people-organization-provisioning`. Exact selected titles drive execution, so unrelated people cases in the storage file stay unselected. Both storage legs run whichever sign-in host is selected; those record assertions remain storage-component observations, not Node-listener observations. An offered relevant file omitted by the runner, selected skip, missing evidence or target mismatch fails.

The real-central `b2e-joint-journey` case has its own artifact pin and receipts and is explicitly unselected here. The agent journey separately retains the management-boundary cases. Neither lane is proven by this recording-peer journey.

## What decides a pass

The technical expectations in this recipe govern: a statement lasts 120 days; renewal begins at 60 days remaining; pending renewal retries preserve exact bytes; only authoritative empty central state permits setup recovery; one default 5-second guard budget covers stamp handling and all pending revisions; any pending revision at the deadline refuses the original call. The tables below map these obligations to permanent tests in this tree.

Read the selected permanent files and their storage-case definitions under `packages/sign-in-test-support/src/` before relying on their assertions:

| Entry and observation | Real boundary and readback | Wrong behavior rejected |
| --- | --- | --- |
| Confirmed owner creates an organization | `people-organization-provisioning`: one private send for returned UUIDv7; EdDSA verified against public JWKS; exact type/purpose/version/issuer/identity audience/subject/organization, `exp = iat + 10,368,000`, no setup `replaces`; direct `fleetState` read after confirmation | dropped after-create hook, missing request statement, unsigned/one-year stamp, ready before confirmation |
| Peer 403/409/422, unavailable/lost reply, explicit retry | same file: real host transport and status parsing, exact retry outcome and pending row after each refusal/uncertainty; final 200/body confirmation permits ready; exact counts; reads/refused callers send nothing | refusal as success, automatic retry on page read, unauthorized or wrong-organization retry |
| Native server-only signing endpoint | `organization-statement`: actual `jwks.id = kid`, closed header/claims and signature verification; extra caller fields rejected without new key; public signing routes 404; edited predecessor invalidates signature; OAuth token and stamp cannot substitute | caller-selected claims/key, public signer, unsigned predecessor, access token as stamp |
| Renewal on a revision push | `organization-statement`: exactly 5,184,000 seconds left renews first; one second further away is retained; the original push follows; signed predecessor and native signature are checked | old window, renewal after the call, wrong predecessor |
| Lost answers and conditional writes | host and dual-storage cases retain the sent bytes across a reopened store, re-send after loss before/after swap, force overlapping claims and stale settlement; read the actual row and captured bytes | two pending statements, regenerated retry, stale clear erasing newer work |
| Valid versus expired confirmed stamp | valid stamp plus failed renewal still sends; expired stamp plus failed renewal gives unavailable with no original dispatch; successful renewal releases the call | valid use blocked by a renewal failure, or use over an expired stamp |
| Bounded renewal (D7) | one injected deadline, default 5 seconds, covers replace/re-send and seed/reconcile reads; a held peer observes abort and the guard ends even if that peer never resolves; pending bytes and one unanswered timeout survive, then the next use re-sends identical bytes | no deadline, a fresh budget per RPC, timeout recorded as refusal, cleared pending bytes, or an aborted renewal signal passed to the original call |
| Guarded forwarding and relay | the real HTTP routes refuse an original call over an expired stamp until the same sent statement lands; central admin arrivals are read back | a guard wired only into the drainer |
| Counters and pending expiry | unanswered/refused counters remain cumulative and separate, with last time/reason; an expired sent statement is retained and never automatically replaced | uncertainty called success, merged counters, recovery past the signed statement's lifetime |
| Key change | the server-only entry re-signs every ready organization whose stamp uses an old key, ignoring the 60-day window for idle and not-due organizations; current-key stamps are retained; an old-key pending statement is settled first and unfinished re-sign work is named | a replay mistaken for completion under the new key, or a second renewal path |

The setup path is native create → `afterCreateOrganization` → `ensureOrganizationProvisioned` → native signer → private central link. A confirmed provisioning answer is followed by a digest read and a conditional seed of central's actual digest/expiry/key; setup never assumes the submitted bytes were stored. Native Better Auth owns keys and injected Drizzle owns the organization columns. Social-provider and Turnstile protocols remain controlled fixtures.

Before a revision push, admin forward or admin relay, `createOrganizationFleetCallGuard` enters server-only `prepareOrganizationFleetCall`. The guard reads the persisted record, seeds missing facts from central, signs only when needed, and uses conditional set/settlement writes. No renewal timer or scheduled trigger remains. Deploy and Node startup backfill remain separate from the after-response hint and on-use guard; no periodic drain remains. Node startup integration and Cloudflare trigger tests own their wiring checks. IDs and clocks use the existing injected controls.

If setup's digest read fails, the first use tries to seed it. An unavailable seed read records `unanswered-seed-unavailable` and lets the original call reach central. If that organization went unused until its unrecorded stamp expired, central refuses the seed and the original call; sign-in cannot recover automatically. This limit is not a renewed stamp or a successful call. A known expired confirmed stamp with no sent statement can still be renewed successfully.

These are sign-in observations. Actual central admission, key retirement/cold restart and integrated Fleet obligations remain separate.

For D7, drive the injected timer only after the held peer records arrival. A peer that answers unavailable immediately does not prove the deadline. Require a held initial seed read and staged seed→replace and stale→reconcile paths to check the shared budget and timeout classification. Every deadline records `unanswered-timeout`, including a reconcile read; it is never counted as refused. Keep the transport's response unresolved after abort when checking that the deadline itself ends the guard's wait.

The D7 host layers are distinct. The built Node listener journey checks the held-peer deadline and original drain's dispatch or suppression. Separately, Node startup integration composes the production host from source over the real Unix transport and observes the peer connection close. Exact peer-close observation in the built artifact remains unverified; report these two layers separately. Workerd proof traverses the real server-only guard and client in the storage Worker with a held `CentralTransport`, with original Fleet dispatch observed through the existing workerd host path where available. Production `CENTRAL` service-binding abort propagation remains unverified: the HTTP harness reconstructs incoming requests without their signal. Retain this limit alongside direct proof that the guard ends when the transport ignores abort. Name these layers separately in the handback.

Keep the real-central B2e lane separate: both central builds must retain the distinct signed-proposals stale-predecessor negative (200 then 409, winning stamp and records unchanged) and the identical-replay positive (200 then 200). Node startup integration also retains the post-close listener-stopped and provider-secret/account/path canary assertions. Organization journey counts do not stand in for these separate gates.

## Retain and inspect evidence

Keep the runner's private evidence directory after teardown: command/exit/counts, install/build/runtime logs, Vitest JSON, case/phase events, process-group cleanup receipt, `declared-target.json`, `bundle-manifest.json`, `organization-compared-target.json`. For Node also keep `node-manifest.json` and `node-harness-*.json`: initiated and actual invocation IDs, method/path and body hashes must match. These invocation receipts do not bind headers/query strings.

The record cases execute a separate source-bundled storage Worker on both host selections. `organization-storage-application.mjs` and the declared `organizationStorageModules` freeze its application, clock and startup bytes; `storageComponentProof` compares every observed storage-module map. These component records do not inherit the HTTP harness's seven-artifact identity or turn into Node-listener observations.

Each harness exports `organization-evidence-<receiptId>.json` before cleanup. The runner requires one per harness; match its ID with `harness-<receiptId>.json`. It contains:

- D1/better-sqlite3 identity and final organization setup/stamp records: confirmed digest/expiry/key, full sent JWS, last renewal time, separate cumulative counters and last attempt time/outcome. Retained dates are explicit Unix milliseconds; stamp expiry stays Unix seconds;
- native `jwks` `{id, publicKey}` rows, without private keys or session/client credentials;
- `exchanges`: accepted private protocol requests' original UTF-8 bodies and fixed route, response status/body or lost-reply marker. JSON escaping preserves the body string; it is not the parsed object's reserialization. Compare organization and JWS contents with the semantic assertions. Digest replies contain scripted facts, not independently verified central storage.

These are final row snapshots. Intermediate pending/ready states are directly asserted by the permanent tests; final rows cannot reconstruct them. Headers, arbitrary refused bodies and socket framing are absent. The peer records schema-accepted requests and never authorization values. Keep statement bodies private and publish redacted outcomes/paths.

Exit 0, HTTP 200 or `fleetState=ready` alone never passes. Require every selected semantic assertion, matched target/artifacts/readiness/Node receipts, and corresponding request-body/row files. Inspect evidence after cleanup to confirm it survived.

Sensitivity is separate: name a wrong build from the table and retain its intended assertion red plus restored same-case green when a mutation grant permits it. Otherwise inspect applicable earlier control receipts with their source/dependency limits, or report sensitivity unobserved. Do not mutate product code under this skill's drive grant.

## Cleanup

The harness closes its workerd, Node listener, private Unix peer and owned HTTP servers. The process runner retains the exit and remaining-process-group result; remaining members fail. Preserve evidence/runtime SQLite roots until consumers finish. Stop only recorded owned PIDs/groups. A stalled harness is a harness failure with partial evidence, never a product red; do not kill other agents' processes.
