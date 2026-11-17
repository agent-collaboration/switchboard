# Synthetic configuration examples

`oauth-v3.config.jsonc` and `tool-portal-google-policy.config.jsonc` form the pair compiled by `oauth-config-examples.integration.test.ts`. The identities, provider registrations, example vault/item names and secret references are synthetic. They identify no deployment or usable credential. Replace them with deployment-owned values before use.

The integration test checks both complete agent profiles and their different policy defaults. Moving the examples here keeps that real parser/compiler coverage in the public source tree.
