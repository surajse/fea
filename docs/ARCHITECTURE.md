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

## The reader adapter (v0.2)

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
