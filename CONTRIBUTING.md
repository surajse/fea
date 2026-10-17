# Contributing

## Ground rules

1. `pnpm verify` must be green before any PR: typecheck + eslint + vitest + build.
2. No `any`. No LLM in deterministic paths (spec validation, firewall, scoring).
3. Every new MCP tool gets: core method + server wiring + CLI command + test.
4. The clean-room firewall is sacred: synthesis context = whitelist projection
   of the spec. If your change adds a field that crosses the wall, it needs a
   test proving it carries behavior, not internals.
5. Parity reports must stay honest: what was compared, what was normalized,
   what failed. Never present a score as a proof.

## Setup

```bash
pnpm install
pnpm verify
```

## Repo map

See `docs/ARCHITECTURE.md`. The product blueprint (PRD/MVP/roadmap) is
`~/workspace/your_files/fea-blueprint.md`.
