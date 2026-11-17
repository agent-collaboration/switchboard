# Contributing to Switchboard

Read [AGENTS.md](AGENTS.md) before editing. Keep changes focused on the owning package and preserve the public contracts its consumers use. Discuss changes to persisted data, public interfaces, authority, and ownership before implementing them.

Install with `pnpm install --frozen-lockfile`, then run `pnpm build`. Before submitting, run `pnpm check`, `pnpm test:unit`, `pnpm test:integration`, `pnpm python:test:host`, and the applicable `pnpm test:e2e:host` proofs from the repository root. Report commands, exit codes, counts, prerequisites and unverified behavior. A skipped platform case is an explicit proof gap.

Use synthetic identities and private temporary roots in tests. Keep tokens, cookies, signing keys, credential references, personal data and runtime screenshots out of Git. Report suspected security issues privately to the maintainer rather than putting sensitive details in a public issue.

Original project material is AGPL-3.0-only, with the exceptions listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Preserve upstream copyright, license and modification notices when adapting code. Include provenance for copied or generated source.

Read [CLA.md](CLA.md) and keep the Contributor License Agreement section in the pull request template intact when opening a PR. It records assent for contributions made under the agreement, without altering earlier grants or third-party rights.
