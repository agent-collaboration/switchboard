# Switchboard

Switchboard provides tool access, sign-in, and OAuth packages for agent applications. Tool Portal exposes capability contracts and dispatches calls through Node or Cloudflare hosts. Sign-in manages people, organizations, native owner clients, and workspace-bound agent issuance.

## Package map

- [tool-engine](packages/tool-engine/) owns capability execution; [tool-access](packages/tool-access/) owns admission and authorization contracts.
- [tool-host-core](packages/tool-host-core/), [tool-host-node](packages/tool-host-node/) and [tool-host-cloudflare](packages/tool-host-cloudflare/) compose the runtime hosts.
- [agent-portal-sdk](packages/agent-portal-sdk/) provides TypeScript contracts and clients. The [Python SDK](python/agent-vm-agent-portal-sdk/) retains its existing module and distribution names.
- [sign-in-core](packages/sign-in-core/), [sign-in-host-node](packages/sign-in-host-node/) and [sign-in-host-cloudflare](packages/sign-in-host-cloudflare/) implement sign-in with Better Auth and SQLite or D1 storage.
- [tool-access-ui](packages/tool-access-ui/), [auth-ui](packages/auth-ui/) and [oauth-approval-ui](packages/oauth-approval-ui/) provide the user interfaces.
- [oauth-broker](packages/oauth-broker/), [oauth-broker-contracts](packages/oauth-broker-contracts/) and [config-contracts](packages/config-contracts/) provide OAuth and configuration boundaries.

Package READMEs, exported types, and permanent tests describe the supported surfaces. Deployment examples use placeholders or synthetic identities; provide your own deployment configuration and credentials.

## Development

Use Node 24 or later, pnpm 10.33.0, and uv for the Python workspace. Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test:unit
pnpm test:integration
pnpm python:test:host
pnpm test:e2e:host
```

Host tests exercise real local Node and workerd boundaries; some require Chrome or platform-specific facilities. See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), and the [local sign-in verification recipe](.agents/skills/verify-auth/SKILL.md) for prerequisites and proof limits. Local fixture success does not establish hosted authentication or live provider acceptance.

## License and contributions

Original project material is licensed under [AGPL-3.0-only](LICENSE), subject to the third-party exceptions in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Existing grants for earlier MIT releases remain in effect. This source publication does not change upstream licenses.

Contributions use the [Contributor License Agreement](CLA.md) and its assent section in the pull request template. The CLA applies to contributions made under it; it does not establish rights over older third-party work. See [CONTRIBUTING.md](CONTRIBUTING.md).

Source repository: [agent-collaboration/switchboard](https://github.com/agent-collaboration/switchboard). Switchboard was extracted from Agent VM; existing protocol literals, package compatibility oracles, and Python module names are retained.
