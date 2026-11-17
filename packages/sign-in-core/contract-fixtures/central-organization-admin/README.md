# Central organization admin wire

Consumer copies from codex-router `main` `ea030e51350a457d061fa8b913f483ed0d289279` (#275 merged), `crates/collaboration-central-core/contracts/`. That is central's own schemars contract export, which an export test checks for drift.
- The files are the `OrganizationAdminResult`, `CreateWorkspaceRequest`, `WorkspaceLookupRequest`, `ReadChangeRecordsRequest` and `OrganizationAdminIntent` triplets: schema, fixtures and negatives each.
- They use Switchboard formatting (oxfmt); their parsed JSON equals the producer files. Do not rewrite the producer cases or schemas here.
- `OrganizationAdminIntent.vectors.json` is older. It is the JCS-and-digest vectors from codex-router `7fb2de88adf4751cd0ca3398a4b1d41d91342921`, made by central's independent JS oracle. Central publishes no digest vectors. Its intent schema keeps the vectors' shape, and the intent fixtures are checked against the same builder.

The schemas are central's **serialization** schemas. For example, `ReadChangeRecordsRequest`'s schema requires `after` on output, while central's own test accepts an omitted `after` on input and serializes it as null; sign-in reads an absent `after` as null the same way. Don't infer an input restriction from an exported schema.

SHA-256 of the producer bytes as copied (before formatting):

| File | SHA-256 |
|---|---|
| `CreateWorkspaceRequest.fixtures.json` | `9bed142572782ee4d758eb7c9b7d4effc0894a06fef66270772af36b20cce1b3` |
| `CreateWorkspaceRequest.negatives.json` | `014628c3eb25a30f290c9bf77d92976454b09717eaa0687dd44bb950832f29f6` |
| `CreateWorkspaceRequest.schema.json` | `deae4808251000629ff5d4846ba4ed8254a5268e290f962b70e81bfe26faf820` |
| `OrganizationAdminIntent.fixtures.json` | `fea99bb91f7ccb5777c798f1fd0a8755dc8b56857206cf266a5de705e25cfef0` |
| `OrganizationAdminIntent.negatives.json` | `c3e4977c3edcd1c7af429ae496a9a1e71a74e9a26a022c1ff609ba0e4bccae31` |
| `OrganizationAdminIntent.schema.json` | `163a1090fc66e0cf88c530e4c320b96bd4dc319ebde5be1545fcce584b6798c2` |
| `OrganizationAdminResult.fixtures.json` | `99bd6a4d660b1ae3b19d0a04b9dc6024abc5958ff476d711cf1e0e4e8c664839` |
| `OrganizationAdminResult.negatives.json` | `9ec6b0a37b353ce55d4934e469e0d1afa6aac2669c779c2966e0937a3c29cd19` |
| `OrganizationAdminResult.schema.json` | `5799a2f89166181d7e299490fd1651c0f99cd152002b000ff5b6a9fe2b9a2640` |
| `ReadChangeRecordsRequest.fixtures.json` | `2e8ae8ae14278f89faa4703afddbc74717c36a6a900943aff34b4fd6b75b7955` |
| `ReadChangeRecordsRequest.negatives.json` | `759a6f43ada0c7f2eedea3fbf4886ef1d6fb094ac36cfb364351707c970efba9` |
| `ReadChangeRecordsRequest.schema.json` | `f6da8f53d0284af72d9f7e8968a70ec7362a56332b2670e244dd73389daec79a` |
| `WorkspaceLookupRequest.fixtures.json` | `4564344707b8abfc6fb216c8b919157529bf48b8234ce199247f992ecf18880f` |
| `WorkspaceLookupRequest.negatives.json` | `0b3e86859f4d2fc39354c51b72ebf5e150fe16a7dcf7d57833acfb7607100add` |
| `WorkspaceLookupRequest.schema.json` | `0f1d06d10d82fba9f9474728552e96e6058b13132e29bda8dfa67e319027ffd8` |

`POST /organization-admin/v1/{create-workspace,workspace-lookup,change-records}` travels the private link. It carries `Authorization: DPoP <person-fleet token>` and `DPoP: <proof>`; the proof's `intent` is base64url(SHA-256(JCS(intent))). Central answers 200 with one `OrganizationAdminResult`. It answers 401 with an empty body for any token or proof failure, 400 for a body it cannot parse, and 503 when it cannot answer.

The intent vectors come from central's own independent oracle, so the sign-in side's expected digests never come from its own builder. These fixtures define parsing and the intent only. The recording peer in `sign-in-test-support` earns no credit for central's ledger, admission or organization isolation.
