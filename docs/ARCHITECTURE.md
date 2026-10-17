# Architecture

The full architecture lives in the blueprint (`~/workspace/your_files/fea-blueprint.md`, §6).
This is the code map:

```
packages/spec       BehaviorSpec v1 (Zod) + builder from vectors. Deterministic, no LLM.
packages/sandbox    SandboxBackend interface: SpawnBackend (default) + DockerBackend
                    (FEA_SANDBOX=docker). Bounded execution everywhere.
packages/readers    TargetDescriptor + black-box capturers (CLI spawn, HTTP fetch)
                    + ReaReader: MCP client adapter for REA (default `rea mcp`
                    over stdio, or Streamable-HTTP URL). probeRea() for doctor.
packages/cleanroom  Firewall: whitelist projection of spec → synthesis context.
                    ProvenanceLog: hash-chained JSONL audit trail.
packages/oracle     Differential parity: run original vs rebuild on vectors,
                    compare after normalizers, score 0–100 with failing vectors.
packages/mcp        FeaStore (JSON) + FeaCore (10 operations) + MCP server (10 tools).
apps/cli            `fea` command — same 10 operations from the terminal.
```

## The loop (data flow)

```
ingestTarget  → TargetDescriptor (sha256, kind)
captureBehavior → VectorSet (recorded I/O)
extractSpec   → BehaviorSpec (validated; every item evidence-linked)
planRebuild   → plan + one-time approval token (human gate)
synthesisContext(token) → firewalled behavior-only context; token consumed
                  ... agent writes rebuild/ from the context ...
verifyParity  → ParityReport { score, failingVectors }
exportPack    → pack/ (spec + report + provenance + manifest w/ sha256)
```

## The reader adapter (v0.2) and persistent sessions (v0.4)

```
REA MCP server ──MCP──▶ ReaReader ──▶ fea_read ──▶ ReaderNotes (store/notes/)
      (analysis side)                        │ evidence kind "reader-note"
                                             ▼
                                    extractSpec --notes → spec.evidence[]
```

Reader findings live on the **analysis side** forever. The firewall rule is
unchanged: `createSynthesisContext` only projects the spec's behavioral
fields. Reader notes reach a spec as *evidence references*, never as content
— a synthesis agent can see "surface X was confirmed by rea_list_exports",
never decompiled code.

v0.4 adds the persistent session proxy for document-stateful readers:

```
┌─ fea reader serve ─────────────────────────┐
│  ONE ReaReader (rea mcp stdio)              │
│  loopback HTTP 127.0.0.1:3210 + token      │◀── fea read --proxy-url … (any number of calls,
│  POST /call {tool, args}                    │     same REA document session)
└────────────────────────────────────────────┘
```

Without the proxy, each `fea read` spawns a fresh `rea mcp` process, so
`open_binary` in one call is invisible to the next. With it, the whole
`open_binary → list_strings → …` workflow shares one session.

## Normalizer packs (v0.4)

`@fea/oracle` ships named packs (`http`, `log`, `path`, `ids`) for common
non-behavioral noise. Packs are additive on the default normalizers and
every applied normalizer is listed in the parity report — if a pack hides a
real difference, the report shows exactly which pattern did it.

v0.5 adds `ansi` (terminal escape codes) and `json` (structural: whole-body
JSON is parsed, keys sorted, re-stringified — reported as
`json-canonicalize` so it stays auditable).

## Proof of proof (v0.6)

FEA's thesis is "prove it" — v0.6 turns that on FEA itself:

```
pack_<id>/ ──▶ fea pack-verify ──▶ manifest parses?
  manifest.json                          every file present + sha256 match?
  spec.json                              spec re-validates (BehaviorSpec v1)?
  parity-report.json                     report id matches manifest?
  provenance.jsonl                        hash chain verifies? (first break pinpointed)
```

`verifyProvenanceChain` (pure, in `@fea/cleanroom`) returns the first
broken entry instead of a bare boolean. `ProvenanceLog.verify()` delegates
to it.

## HTTP parity (v0.5)

```
recorded vector: GET http://original:3000/users?page=2
                          │ swap origin
                          ▼
original: GET http://original:3000/users?page=2 ─┐
rebuild:  GET http://rebuild:3001/users?page=2  ─┴─▶ compare status + headers + body (normalized)
```

`runParity` takes `rebuildUrl` for HTTP vectors; each vector kind needs its
own rebuild (`rebuild` binary path for CLI, `rebuildUrl` base for HTTP).
Mixed vector sets are allowed. `fea verify` picks via `--rebuild` /
`--rebuild-url`; `core.verifyParity` validates against the target kind
(`apk` honestly refuses — it needs a launched-app harness).

## Policy gate (v0.3)

Execution-class tools pass through `@fea/policy` at the **interface layer**
(MCP server, CLI) — never inside `FeaCore`, which stays direct for tests and
programmatic use:

```
MCP fea_capture_behavior ─┐
CLI fea capture --yes ────┴─▶ PolicyEngine.check() ─ allow ─▶ run
                                                ├─ ask ──▶ stage approval
                                                │           (fea_approve / fea approve --token)
                                                └─ deny ─▶ refuse with error
```

- `fea_approve` is always allowed (denying it would deadlock approvals).
- Plan approvals (fea_plan_rebuild → fea_synthesis_context) are a separate
  mechanism: they gate *synthesis*, not execution.

## Key invariants (enforced in code + tests)

1. `BehaviorSpec` never contains implementation internals — schema has no such fields.
2. `createSynthesisContext` is a whitelist projection; `assertNoForbiddenKeys` scans it.
3. The approval token is single-use; synthesis without `planRebuild` is impossible.
4. `verifyParity` refuses to run without a captured vector set.
5. Every mutation appends to the provenance log; `verify()` detects tampering.
6. Parity is behavioral comparison, never claimed as proof — see DISCLAIMER.md.
