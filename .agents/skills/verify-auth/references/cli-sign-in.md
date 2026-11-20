# CLI sign-in and Continue

Expected result: B1-B Specification S10 / Verification V8 and the adopted PR8 keyboard regression preserve the original CLI authorization across sign-in, factor setup and Continue. The [owner CLI contract](../../../../packages/sign-in-owner-cli/README.md#fleet-commands) requires native code plus S256 through a loopback callback; the [core contract](../../../../packages/sign-in-core/README.md) requires the pending authorization to survive forms and session-cookie rotation. Keyboard activation and a stable native click submit the intended Continue form.

The owner launches the delivered CLI, signs in through the service, and resumes the original authorization request. Keyboard activation still submits the same Continue form after a late layout change; stable native click reaches the intended control.

Requires public main 7e32e00e or a descendant, existing Chrome and native build prerequisites. Run `pnpm exec tsx scripts/verify-auth/cli-sign-in.ts --commit <sha>`.

1. In a fresh target, drive native-cli-keyboard-activation and native-browser-click on both host selections. Observe trusted native input at the intended button/form and the forced-order layout assertion.
2. Run the existing bootstrap journey's permanent cases. Observe fixed native client setup, PKCE/loopback/cookie boundaries and its delivered owner CLI, not a helper-only substitute.
3. Read actual test results and owned cleanup in the five-fact report.

Failures that matter: a click landing elsewhere, no native form submit, lost authorization continuation, wrong public client or bootstrap authority. The pure layout fixture is labelled as such; it is not another authenticated sign-in.

Gotchas: no script touches Keychain. Host tests may use private temporary file caches, which must not be published. CLI process completion and cleanup are part of the result; a still-running process is not a pass.
