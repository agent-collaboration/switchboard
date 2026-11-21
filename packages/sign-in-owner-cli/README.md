# Sign-in owner CLI

Node client for native S256 authorization through a loopback callback, followed by live owner-management commands. It requests short-lived management credentials; expiration requires another authorization.

The checkout entrypoint `scripts/verify-auth/owner-cli.ts` loads the built owner CLI. Build the workspace before invoking it from the monorepo root.

```sh
mise exec node@24.7.0 -- pnpm exec tsx scripts/verify-auth/owner-cli.ts --help
```

Target JSON and token caches must be owned mode-0600 files outside Git checkouts. Organization, workspace and operation request UUIDs must be version 7. Credential output is created privately and requires a new destination file. `--no-browser` prints an authorization URL for another browser; each management request still checks the live Person and session.

## Fleet commands

`fleet-login`, `fleet-create-workspace`, `fleet-workspace-lookup` and `fleet-change-records` act on the organization's Fleet at central. They need `centralAdminAudience`, `centralPublicOrigin` and `ownerFleetCliClientId` in the target.

- **Sign-in:** native code + S256 through the loopback callback. `--no-browser` prints the URL for a browser on another machine. `--device` is not available yet: it exits non-zero and sends nothing.
- **Key binding:** the CLI makes an ES256 key. The token exchange binds a person-fleet access token and a refresh credential to that key with DPoP (t15e), and the refresh credential is useless without the key.
- **Requests:** each command signs its own DPoP proof with the operation's `intent` and sends it through the sign-in relay (`/api/auth/organization-admin/v1/*`). The relay passes it unchanged to central's link-only admin routes. The proof's `htu` names central's endpoint (`centralPublicOrigin` + path), not the relay.
- **Second factor:** if central answers `secondFactorRequired`, the CLI opens (or prints) the sign-in page and waits. After you confirm and press Enter, it refreshes with the same key and retries that command once, with the same operation ID. Typing `cancel` stops it, and nothing is retried.
- **Lost replies:** if central's reply is lost, repeat `fleet-create-workspace` with the same `--operation-id`; it will not run twice.

### Security: where the key lives

On macOS the key and its refresh credential are kept in one login-Keychain item:
- service `dev.switchboard.fleet-cli`;
- account `<issuer>|<clientId>`;
- written through `/usr/bin/security` with the value on stdin, never on the command line.

**The key is extractable so it can be stored, and any process running as you can read the item through `security` without a prompt.** That is the accepted cost of keeping the key across commands (t15b, "keyring, otherwise memory").

Elsewhere, with `--memory-only`, or if the Keychain fails, the CLI warns and holds both in memory for that one command, and the next command signs in again. Off macOS and with `--memory-only` the key is non-extractable. If the Keychain fails only when saving a key it has already made, that same extractable key stays in memory for the rest of the command. Nothing is ever written to a file.

