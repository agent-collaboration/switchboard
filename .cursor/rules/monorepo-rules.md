---
alwaysApply: true
---

# Monorepo rules

Use pnpm for the TypeScript workspace and uv for the existing Python workspace. Run commands from the repository root, targeting the affected package. Follow its current folder structure and import aliases; preserve established relative imports when editing existing modules.

Keep pure models separate from storage and external-service effects. Use the existing owning package for a responsibility rather than adding a wrapper layer. Follow [AGENTS.md](../../AGENTS.md) for test taxonomy and proof commands.

Changes to tsconfig, Python tooling configuration, public contracts, persisted formats or ownership require explicit agreement. Do not introduce Python package roots or dependency changes as incidental cleanup.
