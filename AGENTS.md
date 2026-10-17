# AGENTS.md — FEA

## What this repo is

FEA (Forward Engineer Anything): MCP server + CLI for verified software
reimplementation. Loop: ingest → capture → spec → synthesize → verify → export.

## Conventions

- pnpm workspaces, exact-pinned deps, `pnpm verify` green before commits.
- `@fea/spec` is the contract: Zod schemas, deterministic. No LLM in
  spec/cleanroom/oracle packages — ever.
- Clean-room firewall: `createSynthesisContext` is whitelist-only. New fields
  crossing the wall need a test proving behavior-not-internals.
- MCP tools, core methods, and CLI commands stay 1:1:1. Add all three + test.
- Provenance log: every mutation appends; never rewrite history.
- Honest reports: parity = behavioral comparison on listed vectors, not proof.

## Don't

- Don't add decompilers/readers beyond the adapter interface (v0.1).
- Don't add license/DRM-circumvention workflows.
- Don't weaken `assertNoForbiddenKeys` or the approval gate.
