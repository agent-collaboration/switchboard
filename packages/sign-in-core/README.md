# Sign-in core

Portable sign-in rules and SQLite schema. Hosts supply a fresh Drizzle database factory, clock, UUIDv7 source, fixed atomic-batch runner and request limiter through the required capabilities.

Hosts also supply `log(SignInObservation)`. Closed records describe captcha refusals, request limits and unconfirmed organization setup or people changes. They carry bounded reasons and operation identities, with no provider message, token, address or arbitrary request text.

- `@agent-collaboration/sign-in-core` exports domain rules, contracts, schema and stores. Its import and declaration graphs exclude Node, Cloudflare, SQLite drivers and Better Auth.
- `@agent-collaboration/sign-in-core/better-auth` composes Better Auth 1.7.11 with its Drizzle adapter and translates store failures at the provider protocol boundary. Domain rules never import this subpath.

The schema lives in [sign-in-schema.ts](src/storage/sign-in-schema.ts), with generated migrations in [drizzle](drizzle). Better Auth's SQLite adapter serializes JSON once; JSON-bearing columns therefore store plain JSON text, decoded and validated at the store boundary.

Better Auth's organization plugin owns organizations, memberships and invitations. Only the configured, verified owner may create an organization and becomes its owner. Owner and member permissions come from the native access-control configuration. People changes record the authenticated actor's intent before the effect and its outcome afterward. An unwritable intent refuses the change; a lost outcome remains unconfirmed. A store read distinguishes an absent value from `store-unavailable`.

The owner page offers Google or GitHub sign-in and a click-only passkey button, plus native app enrollment with a QR code, manual setup key and one-time recovery codes. Later changes require a second factor confirmed within 15 minutes. Passkey registration, confirmation and sign-in require user verification. The button obtains a fresh Turnstile token for native `GET /api/auth/passkey/generate-authenticate-options`; native `POST /api/auth/passkey/verify-authentication` verifies the assertion and creates a confirmed session. Conditional store operations prevent factor removal from leaving no working factor. Person tokens copy the session's confirmation as `second_factor_at` and `second_factor_method`; minting another token does not refresh that confirmation. [K5/K6 contracts](contract-fixtures/person-identity) document the producer shapes and their proof limits.

The passkey proof routes are the [host cases](../sign-in-test-support/src/people-passkey-sign-in.host.e2e.test.ts) on both Node and workerd and the [real-Chrome V8 journey](../sign-in-test-support/src/sign-in-native-browser.host.e2e.test.ts). They use controlled provider and siteverify responses, injected clocks and Chrome's virtual authenticator. Physical authenticators, real provider identity, real Turnstile and staging remain unverified by these fixtures.

App setup and confirmation retain the validated pending CLI authorization through their forms and return links, including native session-cookie rotation. A person with several memberships chooses an organization by name through the native selection route before continuing; a fresh session with exactly one membership keeps its automatic selection. Raw organization list/get routes remain closed. The token contract admits both factor fields together or neither.

Better Auth's native Turnstile plugin protects social starts before their OAuth state is written. Its expected action and hostname are fixed by the issuer. The outer request limiter runs before public route dispatch, including the service's own pages; Better Auth separately counts its HTTP routes in memory. Hosts validate and normalize their trusted client address before either count. [The route policy](src/request-limits/request-limit-policy.ts) owns the limits. Rate-limited responses publish 429 with standard `Retry-After` headers and closed observations.

Deployment configuration requires `turnstile: { kind: 'deployed', siteKey: '<public widget key>' }`. Local loopback deployments use `kind: 'local'` and may specify a loopback `siteVerifyURLOverride`. A deployed profile rejects loopback issuers and verifier overrides. The plugin derives its hostname allowlist from the issuer; there is no shared localhost allowance or no-captcha profile.

The surrounding packages are [web capabilities](../sign-in-platform-web), [Cloudflare host](../sign-in-host-cloudflare), [Node host](../sign-in-host-node), [owner CLI](../sign-in-owner-cli) and [test hosts and proof](../sign-in-test-support). Both hosts compose the same core and provider boundary over Drizzle, using D1 or a `better-sqlite3` file.

From the monorepo root, check generated migration stability with:

```sh
mise exec node@24.7.0 -- node packages/sign-in-test-support/node_modules/drizzle-kit/bin.cjs generate --config packages/sign-in-test-support/drizzle.config.mts
```

The configuration paths resolve from the repository root.

## Central provisioning

After native organization creation, B2 signs a setup statement for that organization in the native server-only endpoint and sends one plain `POST /internal/organization-provisioning` with `{organizationId, organizationStatement}` through the host-owned link. Only HTTP 200 with the closed `{result:"provisioned"}` reply advances `fleetState` to `ready`. A refusal (403 mismatch, 409 stale, 422 invalid statement), a signing failure, an error, a malformed reply or a lost reply leaves `settingUp`. Nothing retries from a page read, a forwarded request or a background task.

The authenticated owner page shows setup state and offers **Try again** while pending. Its cookie-only endpoint re-reads the live session and membership permission before signing and sending again for the same organization ID; it answers 503 for an uncertain outcome and 409 for a refusal. Refused input sends no provisioning request. Central owns setup idempotency, stamp verification and its records; client or fixture tests alone do not establish them. The producer parser fixtures are pinned in `contract-fixtures/central-provisioning/`.

## Organization statements and renewal on use

Configuration requires a dedicated `centralIdentityAudience` and explicit `organizationStatementLifetimeSeconds: 10368000` (120 days, owner choice 3f); neither has a default. This policy does not change the lifetime of a person's access token. The server-only `signOrganizationStatement` endpoint uses Better Auth's native EdDSA key and protected `fleet-organization-stamp+jwt` type. It accepts an organization ID and optional predecessor digest, and constructs the closed claims from protected configuration and the injected clock. It exposes no public signing route.

There is no renewal job (owner, 9 Nov). Before each sign-in to Fleet call (the revision drain's push, a forwarded admin request and a relayed CLI request; the relay reads the organization from sign-in's own DPoP token for the guard alone), the server-only `prepareOrganizationFleetCall` endpoint checks the organization's stamp record and renews a stamp with 60 days or fewer left, or one signed by a previous native key. Setup's own provisioning send and the guard's digest read are not guarded.

The stamp record is server-written organization columns (`additionalFields`, `input: false`, migration `0004_organization_stamp_record`): the confirmed stamp's digest (lowercase hex SHA-256 of the compact statement, central's own rule), expiry and key ID; the sent statement while its answer is unknown; the last renewal time; and unanswered and refused tries, counted apart and never reset, with the last try's time and outcome. Setup reads central's digest right after a `provisioned` answer and records central's facts, never the bytes it sent, because central answers `provisioned` whether it stored those bytes or already held a stamp; an empty record is seeded the same way on first use, and a failed seed counts one unanswered `seed-unavailable` try.

At most one stamp is in doubt: while one is unanswered, only those exact bytes are sent again, and every write is a conditional update (set the sent stamp only when empty; confirm or settle only while it still holds the same statement), so all instances share one guard. A swap or an identical replay confirms the sent stamp; no answer counts an unanswered try and keeps it; a stale refusal is reconciled from central's current stamp, and any other refusal counts a refused try and clears it. The call itself goes out whenever the confirmed stamp is still valid, and answers the existing unavailable "try again shortly" when it has expired and renewal did not land. A sent stamp that itself expires is never re-sent or replaced. When central answers that it holds no stamp for a ready organization (it started empty), whether on the seed read or on the reconcile read after a stale refusal, the guard forgets the record, signs a fresh setup statement with no predecessor, provisions it inside the same deadline and seeds the record from central's digest read; until that lands, the call answers the existing unavailable answer. A link that fails or times out is never taken for an empty central. An organization that is not due reads nothing on a normal call, so pinned central's answer for a store it no longer holds (a bare 503, the same as being unavailable) is the trigger instead: after an admin call or a revision push gets central's own 503, and only while the deadline has time left, the run reads the digest once. Only an explicit `none` recovers; a stamp, a failed read or a timeout returns the original answer unchanged, and a transport failure is never probed. Recovery forgets the record conditionally (only the stamp it held when the 503 came back), sets this organization's revision ACKs back to 0 (the one place an ACK lowers, since central holds none of its floors), sets the organization up again, delivers its current revisions and retries the call once, all inside the same deadline; the first call itself is never bounded. A setup that does not land counts one try and leaves the record empty for the next use. Because renewal runs inside the original request, one deadline (`organizationStampRenewalDeadlineMilliseconds`, default 5 seconds, on the platform's injected `deadlines`) bounds each guard run: every central call in the run is raced against it and also carries its abort signal, so a transport that ignores the abort still cannot hang the call. A deadline anywhere in the run counts one unanswered `unanswered-timeout` try and keeps the sent bytes; it is never counted as a refusal. The server-only `reSignOrganizationsForKeyChange` endpoint runs every ready organization through the same rules until its confirmed stamp names the current key, and reports any that did not finish.

## Authorization revisions

Two retained fence tables (migration `0003_authorization_revisions`) record what central must refuse: `organization_authorization_revisions` (one row per organization, keyed by its ID: revision, `active`/`stopped`/`deleted`, and the permission policy digest) and `person_organization_authorization_revisions` (one row per organization and person, with its own UUIDv7, kept across removal and rejoin). Each row also holds the acknowledged revision central has confirmed; `revision > acknowledged_revision` means a push is pending.

The provider's database adapter is Better Auth's stock Drizzle adapter with every `member`, `organization` and `session` write that moves a fence routed through one fixed batch (`authorizationFencedAdapter`), so the native row and its fences commit or roll back together. Affected rows are selected inside the batch. A required fence that is missing aborts the batch rather than being recreated at revision 1. Session deletion, including the release fence's own cleanup, bumps every retained pair of that person; deleting an unbound person makes its retained pairs inactive. Native sign-out answers 200 even when its session deletion was refused, so its status is not evidence that a revoke committed.

The policy digest is the SHA-256 of the RFC 8785 serialization of the role → Fleet permission map derived from the native roles (`fleetPermissionPolicy`). It is pinned as a constant; a unit test recomputes it, so a changed mapping can't keep the old digest.

**Undeployed: existing-row backfill.** `backfillAuthorizationRevisions` gives organizations and memberships that predate the tables their fences, insert-or-ignore with injected UUIDv7s, so reruns and concurrent runs converge. The Node host runs it at startup and the Cloudflare host as a deploy step, and both log `authorization-backfill-complete` or `authorization-backfill-unavailable`. There is no cron (owner, 12 Nov): a fenced write whose batch fails backfills its own organizations and retries once, but only organizations with no organization fence and no person pair, which predate the tables. A partial state means a retained row was lost, and r3 never resets one, so that still fails closed, as does a failed backfill. The owner decides whether to adopt it; the revision tables are not deployed to staging until then.

## Person-fleet tokens

Configuration requires `centralAdminAudience`, central's admin audience; it must differ from the management and stamp audiences. The provider seeds a resource for it that requires DPoP-bound tokens and the `fleet:admin` scope. A client must be linked to that resource to obtain one. The owner bootstrap creates the two production clients that are: the admin page's (`adminPageClientId`, native, PKCE, `fleet:admin`) and the fleet CLI's (`ownerFleetCliClientId`, native, PKCE, `authorization_code` + `refresh_token`, `fleet:admin offline_access`). The management CLI client is unchanged. The release fence lets a refresh credential out only beside a key-bound person-fleet token issued to the fleet CLI. A person issuance without a session, which is what the native device grant produces, is refused with `invalid_grant`. A bootstrap that finds a different client under either ID refuses and changes nothing.

For that audience the existing access-token contributor issues the closed `person-fleet` profile (r3 section 4). The issuer samples S from its injected clock **before** dispatching one joined read: the live session, its verified person, the membership in the session's active organization, the retained person/organization fence and the organization fence. A pure decision (`decidePersonFleetIssuance`) then refuses any of these:

- no session;
- a session that ends at or before S;
- no active organization, no membership, or a missing or inactive pair;
- a missing or non-active organization fence;
- a policy digest other than the one this process loaded;
- an unknown role.

Otherwise it adds `token_profile`, `organization_id`, `authorization_subject_id`, both revisions, the policy digest, the sorted Fleet permissions, `session_expires_at_ms`, `authorization_snapshot_at_ms` (S) and `authorization_snapshot_valid_until_ms` (S + the access-token lifetime, at most 300 000 ms), plus the session's original factor facts. Native `iat`, `exp` and `cnf` remain Better Auth's.

The release fence re-reads the signed token under the closed profile and refuses it without `cnf.jkt`, with a malformed or over-long window, or once `now` reaches the snapshot deadline, the signed session deadline or native expiry (equality is expired). It then rechecks the session and membership live. Because native `iat` is sampled before S, native expiry never falls after the snapshot deadline at issuance; central enforces all three bounds again at its applying transaction.

## Delivering revisions to central

A fence row is pending while `revision > acknowledged_revision`. `drainAuthorizationRevisions` pushes each pending row's current version over the private link (`POST /internal/organization-authorization-revisions`; shapes in `contract-fixtures/central-authorization-revisions/`), organizations before persons:

- Only central's 200 `{acknowledgedRevision}` is recorded, and only if it is newer than the stored ACK and not above the current revision. A later local change therefore stays pending.
- A 412 means central lacks the organization floor. The organization's current version is then resent (without lowering its ACK) and the person retried once.
- Any other outcome leaves the row pending and retries it after 60 s.

Drains run after any request that committed a fence change (`deferAfterResponse`: `waitUntil` on Workers, owned work on Node). No timer or cron runs them (owner, 12 Nov). Each organization's guard run, before any sign-in to Fleet call, delivers that organization's unacknowledged rows (its fence, then its person pairs) whatever their retry wait, inside the same deadline as the stamp step. It reads them 100 at a time and keeps reading until a read finds none pending, so a row that advanced while its older acknowledgement was recorded is pushed again at its new revision. A row still unacknowledged, or a deadline before that empty read, keeps the call back with the existing unavailable answer. The after-response drain runs that guard once per organization with rows past their retry time, so a lost hint is delivered by the organization's next Fleet call.

`readSynchronization` answers a conservative current question for three scopes (`personInOrganization`, `personEverywhere`, `organization`): `synced` only when every fence in the scope has an ACK at or above its current revision, otherwise `pending`. It is not a per-change receipt, and no route exposes it yet; the people page that offers removal will.

## Organization admin page

`GET /organization-admin` serves the owner's page for B2's admin commands: create a workspace, list the organization's workspaces, and read its change records. The page holds no token or key (owner decision, 8 Nov). Each action posts to a cookie-only route: `/api/auth/organization-admin/{create-workspace,workspace-lookup,change-records}`. Each route refuses an `Authorization` header, another origin and a request without a live session.

For every action the server works in that request's memory only:

1. It creates a non-extractable ES256 key.
2. Through this same handler, so every admission and release fence runs, it runs native authorization with the person's cookie and PKCE, then the token exchange with a DPoP proof and no cookie.
3. It refuses before sending anything if the token names another organization than the body, or is bound to another key.
4. It signs central's proof `{jti, htm, htu, iat, ath, intent}`. `htu` is `centralPublicOrigin` plus the route; request headers never change it.
5. It sends `Authorization: DPoP` and the proof over the private link, then drops the key and token. Nothing is stored or returned.

Central's `secondFactorRequired` reaches the page, which runs the existing app-code or recovery-code confirmation and then retries that action once, with the same operation ID and a fresh key. A cancelled or failed confirmation sends nothing. The wire is central's published contract (codex-router `7fb2de88a`), vendored in `contract-fixtures/central-organization-admin/`.

