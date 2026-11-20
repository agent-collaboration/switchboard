# Staging sign-in

This journey stays open until BG staging exists. BG SO15 and SO16 own its acceptance.

- **SO15** After each staging deploy, reset and seed test identities through the staging-only `testUtils` routes, then drive every signed-in journey against the deployed build.
- **SO16** Observe the four production refusals and one real Google or GitHub sign-in on staging per release. Use the dedicated test account, or have the owner sign in with a verifier observing.

Bind a screenshot of sign-in to the deployed build and observed session. Read the actual deployed response policy for CSP. To claim a deployed limiter, observe its refusal and unchanged state. Report local passkey observations separately from deployed proof. Machine revocation belongs to B3.
