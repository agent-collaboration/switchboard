# Third-party notices

This inventory covers copied material in the repository source. The root [LICENSE](LICENSE) applies to original Switchboard material; the third-party licenses below continue to apply to their respective material. Inclusion of a dependency or an import does not mean its complete source is copied into this repository.

## Better Auth UI

Source: https://github.com/daveyplate/better-auth-ui/tree/2b028ec5256d6f04879c1a6a1d83822ac23e896f (gitHead `2b028ec5256d6f04879c1a6a1d83822ac23e896f`). Retained and adapted in `packages/auth-ui/src/components/`, `packages/auth-ui/src/lib/`, `packages/auth-ui/src/index.ts` (adapted example) and `packages/auth-ui/src/icons.ts`. Components and imports were adapted for this repository and its Base UI primitives. Non-test source files carry an inline notice. License source: https://github.com/daveyplate/better-auth-ui/blob/2b028ec5256d6f04879c1a6a1d83822ac23e896f/LICENSE.

MIT License

Copyright (c) 2025 daveycodez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## shadcn UI

Source: https://github.com/shadcn-ui/ui; MIT. The exact registry revision used for the copies is unknown. `packages/tool-access-ui/src/components/ui/*.tsx` and `packages/tool-access-ui/src/hooks/use-mobile.ts` use or adapt the `base-mira` Base UI registry components. The synced subset also came through BridgeWeb; see [BridgeWeb theme](#bridgeweb-theme). Imports and component implementations were adapted for this package. The current package declares shadcn 4.22.0, which is not evidence of the copied registry revision. License source: https://github.com/shadcn-ui/ui/blob/main/LICENSE.md.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## input-otp

Source: https://github.com/guilhermerodz/input-otp/tree/3daad8fc88c9a041dbce98e97185efd65b3d87de; version 1.5.0, gitHead `3daad8fc88c9a041dbce98e97185efd65b3d87de`. `packages/auth-ui/src/auth-ui.css` contains adapted input-otp styles. License source: https://github.com/guilhermerodz/input-otp/blob/3daad8fc88c9a041dbce98e97185efd65b3d87de/LICENSE.

MIT License

Copyright (c) 2024 Guilherme Rodz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Cloudflare runtime

`packages/sign-in-host-cloudflare/worker-configuration.gen.d.ts` and `packages/tool-host-cloudflare/worker-configuration.gen.d.ts` contain generated runtime declarations from workerd 1.20260815.1, generated by Wrangler with different compatibility dates and host environment bindings. Their original notices credit Cloudflare and Microsoft Corporation and remain in those files; additional Cloudflare copyright notices also appear within them. The repository added its first-line notice, and the generated declarations include application-specific environment configuration. Source: https://github.com/cloudflare/workerd and https://github.com/cloudflare/workerd/tree/main/types; [Apache License 2.0](LICENSES/Apache-2.0.txt). The complete workerd `v1.20260815.1` repository tree contains no file named `NOTICE`, `NOTICE.txt`, or `NOTICE.md`: https://github.com/cloudflare/workerd/tree/v1.20260815.1. This does not establish whether a separately distributed component has an applicable notice.

## BridgeWeb theme

`packages/tool-access-ui/src/panel-theme.css`, the token mirrors `packages/tool-access-ui/src/design-tokens/bridge-design-palette.ts` and `bridge-design-row-metrics.ts`, the associated `bridge-design-tokens.unit.test.ts`, and the synced UI primitives listed in `packages/tool-access-ui/BRIDGE_SYNC.md` derive from AgentStudio BridgeWeb at `d77e97bb320e1788b475f72aaf1ee042a0b61f14`, copyright 2025 Shravan Sunder, AGPL-3.0; see the root [LICENSE](LICENSE). The panel theme adjusts source paths and omits application-shell styles; the primitives adapt package imports. `packages/sign-in-core/src/pages/sign-in-theme.css` composes the shared theme and auth styles for the sign-in page. BridgeWeb's theme includes the Pierre-related values described below and imports Tailwind CSS, tw-animate-css and shadcn CSS. These imports reference dependencies rather than copying their full source here.

### Pierre theme and diffs

The BridgeWeb theme identifies its ANSI palette and source/gutter selection ratios with Pierre. The exact source revision and extent of copied Pierre values have not been established. The synced BridgeWeb lockfile uses `@pierre/theme` 1.0.3 (MIT) and `@pierre/diffs` 1.2.10 (Apache-2.0). The latter's [Apache license](LICENSES/Apache-2.0.txt) is also included here; its npm 1.2.10 package contained no separate NOTICE file. The applied copyright in `@pierre/diffs` 1.2.10's `package/LICENSE.md` is **Copyright 2025 Pierre Computer Company**; package metadata and license: https://registry.npmjs.org/@pierre%2fdiffs/1.2.10. Pierre theme source: https://github.com/pierrecomputer/theme; package metadata and license: https://registry.npmjs.org/@pierre%2ftheme/1.0.3. Its separate MIT notice follows:

MIT License

Copyright (c) 2026 The Pierre Computer Company

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Tailwind CSS

The shared theme imports `tailwindcss`. The Switchboard lockfile resolves 4.3.3; the synced BridgeWeb lockfile resolves 4.1.13. Source: https://github.com/tailwindlabs/tailwindcss; license: https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE.

MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### tw-animate-css

The shared theme imports `tw-animate-css`; both lockfiles resolve 1.4.0. Source: https://github.com/Wombosvideo/tw-animate-css; license: https://github.com/Wombosvideo/tw-animate-css/blob/main/LICENSE.

MIT License

Copyright (c) 2025 Wombosvideo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### shadcn CSS

The shared theme imports `shadcn/tailwind.css`. The shadcn MIT notice appears in [shadcn UI](#shadcn-ui).

## Producer contract fixtures

The JSON in the following directories consists of consumer copies of codex-router producer contracts, owner material from the same copyright holder. The files use Switchboard formatting while preserving the parsed producer objects; the adjacent README records the producer paths and any additional details. No inline comments are inserted into JSON.

- `packages/sign-in-core/contract-fixtures/central-provisioning/`: `ProvisionOrganization*` from codex-router `13e69413bab1cf61378ece1a137cb9b2644be9b6`.
- `packages/sign-in-core/contract-fixtures/central-authorization-revisions/`: `AuthorizationRevision*` from codex-router `c74b7792dc70f96d981e73c4018c5c2781bd1524`.
- `packages/sign-in-core/contract-fixtures/central-organization-admin/`: five schema, fixture and negative triplets from codex-router `ea030e51350a457d061fa8b913f483ed0d289279`; `OrganizationAdminIntent.vectors.json` from `7fb2de88adf4751cd0ca3398a4b1d41d91342921`.

## Drizzle declaration diagnostics

`packages/sign-in-test-support/contract-fixtures/drizzle-0.45.2-declarations/drizzle-orm-0.45.2-diagnostics.json` and `advisor-experiment/vendor-diagnostics86.public.json` contain diagnostic inventories of Drizzle ORM 0.45.2 declarations under TypeScript 6.0.3. These are diagnostic records, not a copy of the full library. Drizzle ORM declares Apache-2.0: https://github.com/drizzle-team/drizzle-orm and https://registry.npmjs.org/drizzle-orm/0.45.2. The [Apache License 2.0](LICENSES/Apache-2.0.txt) is included for any reproduced declaration material. The package tarball did not contain a separate NOTICE or license file; the upstream repository root supplies the license and has no root NOTICE. No specific Drizzle copyright holder has been established from those sources.

## Other owner-origin copies

`packages/tool-access/src/authorization/{compiled-google-command-resolution,portal-access-policy,mcp-approval-policy}.ts`, `packages/tool-access/src/authorization/cli-allowances/models/cli-allowance-schema.ts`, and `packages/tool-access/src/contracts/{tool-selectors,cli-allowance-policy,mcp-approval-profile,google-application-id,compiled-google-command-set}.ts` identify copies from agent-vm at `7cb295d1`; `packages/tool-access/src/authorization/tool-selector-policy.ts` identifies the corresponding config-contracts source at that pin. `packages/tool-engine/src/test-fixtures/legacy-baselines/gateway-runtime/managed-tool-engine/test-fixtures/managed-profile-test-fixture.ts` identifies a copy from `managed-tool-portal-real-backends.integration.test.ts` at `3031ad24`. These are owner-origin material and remain subject to the root license; original source comments record the provenance.
