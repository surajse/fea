# Architecture

The full architecture lives in the blueprint (`~/workspace/your_files/fea-blueprint.md`, §6).
This is the code map:

```
packages/spec       BehaviorSpec v1 (Zod) + builder from vectors. Deterministic, no LLM.
packages/sandbox    Bounded process execution (timeout, output caps, no shell).
packages/readers    TargetDescriptor + black-box capturers (CLI spawn, HTTP fetch).
packages/cleanroom  Firewall: whitelist projection of spec → synthesis context.
                    ProvenanceLog: hash-chained JSONL audit trail.
packages/oracle     Differential parity: run original vs rebuild on vectors,
                    compare after normalizers, score 0–100 with failing vectors.
packages/mcp        FeaStore (JSON) + FeaCore (9 operations) + MCP server (9 tools).
apps/cli            `fea` command — same 9 operations from the terminal.
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

## Key invariants (enforced in code + tests)

1. `BehaviorSpec` never contains implementation internals — schema has no such fields.
2. `createSynthesisContext` is a whitelist projection; `assertNoForbiddenKeys` scans it.
3. The approval token is single-use; synthesis without `planRebuild` is impossible.
4. `verifyParity` refuses to run without a captured vector set.
5. Every mutation appends to the provenance log; `verify()` detects tampering.
6. Parity is behavioral comparison, never claimed as proof — see DISCLAIMER.md.
