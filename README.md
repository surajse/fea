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

Install (once published): `npm i -g fea-agents` — the `fea` binary. From
source: `pnpm install && pnpm build`.

## What v0.7 is

Continuous proof. v0.7 closes the iteration loop:

- **`fea watch`** — re-runs parity every time the rebuild changes
  (binary: mtime+size; API: content hash of the base URL). Prints each
  run's score and the delta vs the pinned baseline. Ctrl-C stops.
  Policy `ask` needs `--yes` (approvals don't work in a watch loop).
- **`fea pin`** — pins a parity report as the baseline for a
  (target, vector set) pair. Later `fea verify` runs report `Δ vs baseline`
  so regressions are visible at a glance.
- **`fea verify --junit <path>`** — JUnit XML for CI dashboards: one
  testcase per vector, failures carrying the expected/actual diff.

## What v0.6 was

Proof of proof. v0.6 makes FEA's own guarantees verifiable:

- **`fea pack-verify <path>`** (MCP: `fea_verify_pack`, 14th tool) — checks
  an evidence pack end to end: manifest parses, every file present with
  matching sha256, spec re-validates against BehaviorSpec v1, report id
  matches, and the hash-chained provenance log verifies. A tampered pack
  fails with the exact broken check named.
- **Chain pinpointing** — `verifyProvenanceChain` reports the first broken
  entry (`brokenAt` + reason) instead of a bare boolean.
- **Doctor+** — `fea doctor` now also validates the policy file and reports
  Android tool presence (`adb`/`emulator`) for the APK story.
- **APK harness, honestly thin** — `AppHarness` interface + `ManualHarness`
  (you launch the app, FEA takes its HTTP base URL) + `probeAndroidTools`.
  The emulator-backed harness waits for a machine with the Android SDK;
  until then the documented path is launch-it-yourself + `--rebuild-url`.

Dropped honestly: the proxy SSE transport from the old roadmap — it was
a transport swap with no user-visible benefit over the working `/call`
protocol, so it stays out rather than shipping theater.

APIs & onboarding. v0.5 adds:

- **HTTP parity** — the oracle now replays HTTP vectors against two base
  URLs: `fea verify --target <id> --rebuild-url http://127.0.0.1:3001
  --vectorset <id>`. Same path+query on both sides; compares status,
  headers, and body after normalization. Mixed CLI+HTTP vector sets work
  (each kind needs its rebuild).
- **`fea init`** — scaffolds a project directory: `fea.policy.json`
  (recommended), `capture-plans.json` (examples), `FEA.md` (workflow
  cheat-sheet), `.fea/` store. `fea init my-api --kind http-api --target
  http://127.0.0.1:3000` ingests immediately.
- **New normalizer packs** — `ansi` (strip terminal color codes) and `json`
  (structural: parse, sort keys, re-stringify — auditable in the report).

Note: the proxy SSE transport from the v0.4 roadmap stays open — HTTP
parity was the bigger real gap, so it went first.

## What v0.5 was

## What v0.4 was

Scale & ship. v0.4 adds:

- **Persistent reader sessions** — `fea reader serve` holds ONE REA session
  and shares it over loopback HTTP (127.0.0.1 + bearer token), so
  document-stateful workflows (`open_binary` → `list_strings`) work across
  separate `fea read` calls. Use `--proxy-url` / `--proxy-token` on `fea read`
  (or `readerProxyUrl` on the MCP tool).
- **Normalizer packs** — named, auditable noise filters: `http` (RFC1123
  dates, ETags), `log` (timestamps, pids), `path` (temp/home dirs, ports),
  `ids` (UUIDs, hex tokens). `fea verify --packs http,log` — additive on
  the defaults, all listed in the parity report.
- **`apk` target kind** — APK files fingerprint like native binaries; the
  actual analysis goes through the REA reader (JADX/apktool on the reader's
  machine).
- **npm-publish-ready** — every package has publish metadata, the CLI
  publishes as `fea-agents` (name verified free; `fea` itself is taken),
  `npm pack --dry-run` verified. Steps in `docs/PUBLISH.md` — the publish
  itself needs your `npm login`, so it's yours to run.

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

## What v0.3 is

Trust & proof. v0.3 adds three things on top of v0.2:

- **Policy engine (`@fea/policy`)** — allow/ask/deny per tool. Anything that
  *executes* something (`fea_capture_behavior`, `fea_verify_parity`, `fea_read`)
  can be gated: `allow` runs, `ask` stages an approval the human completes
  (`fea_approve` / `fea approve --token`), `deny` refuses. Configure via
  `FEA_POLICY` env, `--policy <file>`, `<store>/fea.policy.json`, or
  `./fea.policy.json`. A recommended profile ships in code
  (`RECOMMENDED_POLICY`).
- **Vector fuzzing** — `fea fuzz --spec <id> --count 50 --seed s1` generates
  deterministic boundary vectors (empty args, NaN, Infinity, unicode,
  huge numbers…) stored as a new vector set, so parity is tested beyond the
  recorded examples.
- **HTML parity reports** — `fea report --report <id>` renders a
  self-contained page (score, failing-vector diffs, normalizers) with no
  external assets.

MCP surface is now 13 tools.

## What v0.2 was

- ✅ Everything in v0.1, plus:
- ✅ **Native binaries** as a target kind (`--kind native`)
- ✅ **REA reader adapter** (`fea read` / `fea_read`): calls any REA MCP tool, stores findings as evidence — REA stays the reader, FEA stays the rebuilder
- ✅ **CI mode**: `fea verify --fail-under 95` exits 1 below threshold
- ✅ **Docker sandbox backend**: `FEA_SANDBOX=docker` (image via `FEA_DOCKER_IMAGE`); `fea doctor` reports backend + docker + REA status
- ❌ Still no decompilers of its own · ❌ No license/DRM circumvention · ❌ Parity is behavioral, not a formal proof

## What's next (v0.8)

Emulator-backed APK harness (needs the Android SDK on the machine),
`fea diff` between vector sets, and the actual npm publish run
(`docs/PUBLISH.md` — needs your `npm login`).

## Docs

- `docs/ARCHITECTURE.md` — how the loop fits together
- `docs/SECURITY.md` — authorization, sandboxing, secret scrubbing
- `docs/DISCLAIMER.md` — read this before pointing FEA at anything
- `../your_files/fea-blueprint.md` — full PRD + MVP + tech-stack blueprint (v1.0)

## License

MIT — see `LICENSE`.
