# FEA — Forward Engineer Anything

> **REA taught agents to read. FEA teaches them to rebuild — with proof.**

FEA is an open-source MCP server + CLI that turns any software artifact into a **verified working reimplementation**:

```
ingest → capture → spec → synthesize → verify → export
```

- **Ingest** a target you are authorized to analyze (CLI binary, HTTP API in v0.1).
- **Capture** black-box behavior into I/O vectors.
- **Extract** a machine-checkable `BehaviorSpec` (Zod-validated, evidence-linked).
- **Synthesize** behind a **clean-room firewall** — the synthesis agent sees behavior only, never decompiled code, addresses, or symbols.
- **Verify** with a **differential parity harness**: original vs rebuild, same vectors, measured score.
- **Export** a reproducible evidence pack (spec + parity report + hash-chained provenance log).

**Positioning:** FEA does not replace [REA](https://github.com/morluto/rea) — it consumes REA (or any analysis tool) as its *reader*. *REA reads. FEA rebuilds.*

## Quick start

```bash
pnpm install
pnpm verify        # typecheck + lint + tests + build (must be green)

# toy demo: rebuild adder.js with 100 parity
node apps/cli/dist/index.js ingest ./examples/toy-cli/adder.js --kind cli --i-have-rights
node apps/cli/dist/index.js capture --target <tgt> --plans '[{"name":"add","argv":["2","3"]},{"name":"bad","argv":["x"]}]'
node apps/cli/dist/index.js spec --vectorset <vs>
node apps/cli/dist/index.js plan --spec <spec>            # human approves here
node apps/cli/dist/index.js synth-context --spec <spec> --token <token>
node apps/cli/dist/index.js verify --target <tgt> --rebuild <rebuild> --vectorset <vs>
node apps/cli/dist/index.js pack --spec <spec> --report <rep>
```

Or install the `fea` command globally from `apps/cli`, or register the MCP server with your agent:

```bash
node apps/cli/dist/index.js mcp     # stdio MCP server — 9 tools
```

See `examples/toy-cli/README.md` for the full demo script.

## What v0.2 is

- ✅ Everything in v0.1, plus:
- ✅ **Native binaries** as a target kind (`--kind native`)
- ✅ **REA reader adapter** (`fea read` / `fea_read`): calls any REA MCP tool, stores findings as evidence — REA stays the reader, FEA stays the rebuilder
- ✅ **CI mode**: `fea verify --fail-under 95` exits 1 below threshold
- ✅ **Docker sandbox backend**: `FEA_SANDBOX=docker` (image via `FEA_DOCKER_IMAGE`); `fea doctor` reports backend + docker + REA status
- ❌ Still no decompilers of its own · ❌ No license/DRM circumvention · ❌ Parity is behavioral, not a formal proof

## What's next (v0.3)

APK reader, policy engine (allow/ask/deny per tool), parity-report web UI, grammar-based vector fuzzing.

## Docs

- `docs/ARCHITECTURE.md` — how the loop fits together
- `docs/SECURITY.md` — authorization, sandboxing, secret scrubbing
- `docs/DISCLAIMER.md` — read this before pointing FEA at anything
- `../your_files/fea-blueprint.md` — full PRD + MVP + tech-stack blueprint (v1.0)

## License

MIT — see `LICENSE`.
