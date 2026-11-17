# Drizzle 0.45.2 declarations: why an exact diagnostic inventory

An isolated packed-library declaration experiment found **86 errors without an ambient shim, 61 with it, and 86 again after removing it**. The shim fixes missing names, but not the structural inconsistencies in Drizzle's declarations. It also makes some otherwise forbidden types and imports available to authored code.

The chosen approach is therefore to retain strict declaration checking and record the known upstream diagnostics individually. That is an explicit limitation in the proof: the upstream declarations do not compile cleanly under these options. It is not a blanket exclusion of Drizzle errors.

## Compiler and scope

The experiment used Node 24.7.0, TypeScript 6.0.3 and Drizzle ORM 0.45.2 against a packed portable library exposing SQLite database types. Both actual `tsc` invocations exited **2**. The relevant compiler options were:

```json
{
  "target": "ES2024",
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "strict": true,
  "exactOptionalPropertyTypes": true,
  "noEmit": true,
  "skipLibCheck": false,
  "types": [],
  "lib": ["ES2024", "DOM"]
}
```

The shim case changed `types` to name only a private declaration-only package and added its isolated type root. This checked compiler behavior after loading the shim, not workspace installation or publication of the shim.

All 86 baseline diagnostics were in Drizzle's own declarations. No baseline diagnostic belonged to the consumer or the portable library's emitted declarations. The companion [diagnostic data](vendor-diagnostics86.public.json) records the observed file, line, code and full message with paths relative to the Drizzle package. It is research evidence from this consumer, not a pre-approved gate implementation or a universal error list for every Drizzle consumer.

## Results

| Diagnostic | Baseline | Shim | Cause observed |
|---|---:|---:|---|
| TS2591 | 14 | 0 | Missing Buffer type |
| TS2307 | 11 | 0 | Missing optional Gel/MySQL driver modules |
| TS2420 | 7 | 7 | Classes do not satisfy declared interfaces |
| TS2559 | 2 | 2 | Role classes and optional config interfaces have no overlapping properties |
| TS2344 | 18 | 18 | Excluded-method unions violate public-key constraints |
| TS2515 | 33 | 33 | Concrete classes omit inherited abstract members |
| TS2416 | 1 | 1 | Incompatible generated-column method override |
| **Total** | **86** | **61** | **25 missing-name errors removed; 61 structural errors unchanged** |

The remaining 61 match the baseline by package-relative file, line, code and full message. For example, `SQLWrapper` requires `getSQL()`, while `SQLiteRelationalQuery` claims to implement that interface without declaring the method. Its `QueryPromise` base does not declare it either. Missing driver module declarations do not repair that class contract.

Other inspected examples are the exact optional property mismatch in `gel-core/policies.d.ts`, the role/config overlap in `gel-core/roles.d.ts`, constrained excluded methods in SQLite select declarations, and the generated-column return type in `singlestore-core/columns/enum.d.ts`.

A separate resolvable declaration containing only `export type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'` still produced 61 errors with the shim. Merely re-exporting the SQLite surface did not remove the problematic declaration graph. No declaration bundler or replacement vendor API was tested.

## What the shim declared

- `Buffer` as a type alias for `Uint8Array`, with no runtime value.
- Module `gel`: opaque `unknown` aliases for DateDuration, Duration, LocalDate, LocalTime, RelativeDuration and LocalDateTime.
- Module `mysql2`: opaque Connection, Pool and PoolOptions aliases.
- Module `mysql2/promise`: opaque Connection, Pool, FieldPacket, OkPacket and RowDataPacket aliases, plus `ResultSetHeader = Record<string, unknown>` to meet a vendor constraint.

These were placeholders for missing names, not faithful driver APIs. They did not produce a zero-error program. Replacing vendor declarations to repair their structural errors would be a different intervention with its own maintenance and fidelity costs.

## Negative controls

The shim program already has 61 vendor errors, so these controls identify **additional authored diagnostics**, not a whole-program green-to-red transition.

| Planted change | Additional authored compiler result |
|---|---|
| `Buffer.from('x')` | TS2693: Buffer has no value |
| `type Example = Buffer` | No additional diagnostic: type use is masked |
| Type import from `mysql2` | No additional diagnostic: import is masked |
| Side-effect `import 'mysql2'` | No additional diagnostic: import is masked |
| Import from `node:fs` | TS2591 |
| Import from `better-sqlite3` | TS2307 |
| Unresolved type in the portable library's emitted `.d.ts` | TS2304 |

Isolated Buffer probes independently produced zero diagnostics for the type alias use and one for the value use. A bounded source-audit prototype caught the Buffer identifiers and stubbed-module imports. This demonstrates the need for explicit source rules if a shim is used; opaque aliases alone do not prevent imports or type naming.

All captured loaded-file graphs lacked actual Node, Cloudflare, SQLite-driver, Kysely, Gel and mysql2 package declarations. That does **not** make the masked imports safe: an ambient stub can satisfy an import without loading the real package. Loaded-file checks and source import rules serve different purposes.

## What an exact inventory preserves and concedes

Keep `strict`, `types: []` and `skipLibCheck: false`. Keep every consumer and first-party diagnostic fatal, including errors in emitted declarations. Compare vendor diagnostics against the exact pinned inventory and fail additions, removals and changes. Classify files by actual resolved package ownership; a pathname substring, a count, or error-code allowlist alone is too broad.

Pin the package and compiler identities with the inventory, retain the raw output, and review the inventory on compiler or dependency changes. Keep the independent broken-declaration and forbidden-import controls, plus loaded-file and runtime architecture checks. Changes to the proof boundary remain explicit decisions; the research data does not authorize future inventory updates.

The cost is acknowledged imperfect upstream declarations and maintenance of their exact inventory. Blanket `skipLibCheck: true` would also skip checking our own emitted declarations and is weaker. Adding the ambient shim as well as an inventory would still require an inventory for the remaining 61 and extra guards against the names the shim introduces.

This experiment did not implement the inventory comparison, prove runtime auth/storage behavior, publish a standalone reproduction, or test a declaration bundler. A clean application build or an inventory match must not be described as all upstream declarations compiling cleanly.

Official TypeScript references: [`types` and global inclusion](https://www.typescriptlang.org/tsconfig/types.html), and [declaration publishing and entry redirects](https://www.typescriptlang.org/docs/handbook/declaration-files/publishing.html). `types` does not prohibit explicit imports; redirecting declaration entries changes which files are checked, rather than repairing those files.
