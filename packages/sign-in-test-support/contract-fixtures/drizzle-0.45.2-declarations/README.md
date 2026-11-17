# Pinned Drizzle declaration diagnostics

`drizzle-orm-0.45.2-diagnostics.json` is the accepted inventory for the sign-in core's existing packed declaration check. It pins Drizzle **0.45.2**, TypeScript **6.0.3**, and all **86** observed vendor diagnostics by package-relative file, error code and complete message. Duplicate occurrences count; discovery order and line positions do not.

The [Advisor's portable experiment report](advisor-experiment/public-report.md) explains the choice. A missing-name shim changed 86 errors to 61 and masked some authored type/import mistakes. No shim is used. The report and its companion data are an immutable research snapshot; only the inventory above is read by the gate.

The core consumer keeps `strict: true`, `exactOptionalPropertyTypes: true`, `types: []` and `skipLibCheck: false`. Every diagnostic outside the actual resolved Drizzle package is fatal, including errors in our emitted declarations and the consumer. An added, removed or changed Drizzle diagnostic also fails. The gate checks the actual loaded declaration graph and first-party imports for forbidden runtime/driver dependencies. Pnpm peer metadata is not a loaded dependency.

These are known upstream declaration errors, not a clean vendor build. The check records the complete diagnostics and expected-inventory comparison in private evidence. Its controls reject an unresolved type added to our published declaration, a Node import and a SQLite-driver import, then require the original declaration and accepted baseline to be restored. Packed-file mutations use atomic replacement to break possible pnpm hard links before writing.

From the repository root, use the existing command:

```sh
mise exec node@24.7.0 -- pnpm exec tsx scripts/verify-portal-package-exports.ts --packed-auth
```

## Updating the pin

1. Change a Drizzle or compiler pin only within its approved delivery scope, rebuild, then run the same packed command. A version or diagnostic mismatch fails; the private evidence contains `core-vendor-actual.json` and the full compiler log.
2. Compare every entry with this inventory. Review each added, removed or changed file/code/message, verify its actual package owner, and keep all first-party and consumer diagnostics fatal. Do not accept only the count or error codes.
3. Obtain **owner sign-off as a check change** before replacing or retiring the inventory. Record the reviewed package/compiler identities and change the versioned filename, schema pin and code pointer deliberately. There is no automatic update mode.
4. Rerun the existing check, its exactness controls, published-declaration/import controls, loaded-file checks and restored baseline. Update this README and the PR's “check scripts touched” entry.

When the vendor declarations stand alone, retire the inventory through the same review and owner approval rather than retaining an empty exception silently. Root check commands, CI steps, lint and the normal repository typecheck are unchanged by this fixture.
