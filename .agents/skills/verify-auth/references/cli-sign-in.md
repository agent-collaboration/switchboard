# CLI sign-in and Continue

The adopted design IDs below refer to owner-held design documents that are not shipped in this repository. The expected behavior stated here is the authoritative public statement for this recipe. Public package contracts are linked where available.

Expected result: B1-B Specification S10 / Verification V8 and the adopted PR8 keyboard regression preserve the original CLI authorization across sign-in, factor setup and Continue. The [owner CLI contract](../../../../packages/sign-in-owner-cli/README.md#fleet-commands) requires native code plus S256 through a loopback callback; the [core contract](../../../../packages/sign-in-core/README.md) requires the pending authorization to survive forms and session-cookie rotation. Keyboard activation and a stable native click submit the intended Continue form.

The owner launches the delivered CLI, signs in through the service, and resumes the original authorization request. Keyboard activation still submits the same Continue form after a late layout change; stable native click reaches the intended control.

Requires public main 7e32e00e or a descendant, native build prerequisites and Playwright Chromium. Run `pnpm exec tsx scripts/verify-auth/cli-sign-in.ts --commit <sha>`.

1. In a fresh target, select the host-named factor and owner pages and `passkey cli-login` cases. The latter launches the delivered CLI and drives the served sign-in and Continue form through completion of the original authorization.
2. Run native-cli-keyboard-activation and native-browser-click as component checks. They exercise trusted native input and forced layout ordering on fixture DOM; they do not establish authenticated continuation by themselves.
3. Run the bootstrap cases for the fixed native client, PKCE/loopback, owner cookie and audit. These launch the delivered CLI with an HTTP browser callback driver, separate from the composed Chrome case.
4. Require the named indispensable observations and read actual test results and owned cleanup in the five-fact report.

Failures that matter: a click landing elsewhere, no native form submit, lost authorization continuation, wrong public client or bootstrap authority. The fixture layout and input checks are components; they do not establish another authenticated sign-in.

Gotchas: no script touches Keychain. Host tests may use private temporary file caches, which must not be published. CLI process completion and cleanup are part of the result; a still-running process is not a pass.
