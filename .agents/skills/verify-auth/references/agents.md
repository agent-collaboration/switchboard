# Owner registers an agent

Expected result: B1-A S11 / V10 preserves the agent path: an agent obtains a token only for its linked workspace, passes the release checks and makes one allowed tool call; a person requesting a tool credential is refused. The owner registers the agent and the checked calls refuse crossed-workspace use. `auth-verification-journeys.ts` selects the permanent observations; it is not the authority for their expected outcome.

Requires public main 7e32e00e or a descendant with the real Node/workerd harness, frozen workspace install/build, published test-key fixtures and recording Central/upstream stand-ins. Run `pnpm exec tsx scripts/verify-auth/agents.ts --commit <sha>`.

1. Build the target fresh. Run each existing agent journey file under its `agent:` selection on Cloudflare and Node.
2. Observe native registration, client/resource links, workspace-bound tokens and Gateway effects/refusals through the permanent assertions.
3. Retain actual test names/counts, failure assertion and cleanup in the report.

Failures that matter: an unowned registration, cached removed authority, a token used outside its workspace, duplicate effects or credential release after a failed fence. No global receipt-readiness rule sits outside the tests.

Gotchas: fixture identity and recording Central are component proof. They do not establish hosted accounts, real Central transactions, vendor replication or staging. A script/fixture unable to drive the behavior is a driver failure; an app that violates the adopted outcome is a product regression and the expectation stays unchanged.
