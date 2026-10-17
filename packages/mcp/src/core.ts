import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  buildSpecFromVectors,
  validateBehaviorSpec,
  type BehaviorSpec,
  type TargetDescriptor,
  type TargetKind,
  type Vector
} from "@fea/spec";
import {
  backendName,
  dockerAvailable,
  probeAndroidTools,
  SpawnBackend
} from "@fea/sandbox";
import {
  ReaReader,
  capFindings,
  captureCli,
  captureHttp,
  describeTarget,
  probeRea,
  summarizeFindings,
  type HttpCapturePlan,
  type ReaderNotes
} from "@fea/readers";
import {
  createSynthesisContext,
  parseProvenanceFile,
  ProvenanceLog,
  verifyProvenanceChain,
  type SynthesisContext
} from "@fea/cleanroom";
import {
  generateVectors,
  runParity,
  type FailingVector,
  type ParityReport
} from "@fea/oracle";
import { PolicyEngine } from "@fea/policy";
import { FeaStore } from "./store.js";
import { dirname } from "node:path";

export const FEA_VERSION = "0.9.0";

/** Human-readable summary of a staged tool call (for approval prompts). */
function describeToolCall(tool: string, args: Record<string, unknown>): string {
  const get = (k: string) => {
    const v = args[k];
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  switch (tool) {
    case "fea_capture_behavior": {
      const plans = Array.isArray(args["plans"]) ? args["plans"].length : 0;
      return `Run ${plans} capture plan(s) against target ${get("targetId")} (executes the target binary)`;
    }
    case "fea_verify_parity":
      return `Verify parity: ${get("originalTargetId")} vs ${get("rebuildPath") || get("rebuildUrl")} on ${get("vectorSetId")} (executes both sides)`;
    case "fea_read":
      return `Call reader tool ${get("tool")} on target ${get("targetId")} (spawns the REA reader)`;
    default:
      return `${tool}(${JSON.stringify(args).slice(0, 200)})`;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JUnit XML: one testcase per vector; failures carry the diff. */
function buildJunitXml(report: ParityReport): string {
  const cases: string[] = [];
  for (const id of report.passedVectorIds) {
    cases.push(`    <testcase classname="fea.parity" name="${escapeXml(id)}"/>`);
  }
  for (const f of report.failingVectors) {
    cases.push(
      `    <testcase classname="fea.parity" name="${escapeXml(f.vectorId)} [${escapeXml(f.field)}]">\n` +
        `      <failure message="${escapeXml(`field ${f.field} differs`)}">${escapeXml(`expected: ${f.expected}\nactual: ${f.actual}`)}</failure>\n` +
        `    </testcase>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="fea-parity ${escapeXml(report.id)}" tests="${report.total}" failures="${report.failed}" timestamp="${escapeXml(report.generatedAt)}">\n${cases.join("\n")}\n    <system-out>parity score ${report.score} (${report.passed}/${report.total} vectors passed)</system-out>\n</testsuite>\n`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreColor(score: number): string {
  if (score >= 95) return "#16a34a";
  if (score >= 80) return "#d97706";
  return "#dc2626";
}

/** Self-contained HTML parity report — no external assets, no JS. */
function buildReportHtml(report: ParityReport): string {
  const color = scoreColor(report.score);
  const rows = report.failingVectors
    .map(
      (f) => `      <tr>
        <td><code>${escapeHtml(f.vectorId)}</code></td>
        <td><code>${escapeHtml(f.field)}</code></td>
        <td><pre>${escapeHtml(f.expected)}</pre></td>
        <td><pre>${escapeHtml(f.actual)}</pre></td>
      </tr>`
    )
    .join("\n");
  const normalizers = report.normalizers
    .map((n) => `<li><code>${escapeHtml(n.name)}</code> — <code>${escapeHtml(n.pattern)}</code></li>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FEA parity report ${escapeHtml(report.id)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  .score { font-size: 4rem; font-weight: 800; color: ${color}; margin: 0; }
  .meta { color: #555; font-size: 0.9rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
  code { font-size: 0.85rem; }
  .note { background: #fffbeb; border: 1px solid #fcd34d; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-top: 1.5rem; }
</style>
</head>
<body>
  <h1>FEA parity report</h1>
  <p class="score">${report.score}</p>
  <p class="meta">
    report <code>${escapeHtml(report.id)}</code> ·
    ${report.passed}/${report.total} vectors passed ·
    generated ${escapeHtml(report.generatedAt)} · seed <code>${escapeHtml(report.seed)}</code><br>
    original <code>${escapeHtml(report.original)}</code><br>
    rebuild <code>${escapeHtml(report.rebuild)}</code>
  </p>
  <h2>Failing vectors (${report.failingVectors.length})</h2>
  ${
    report.failingVectors.length === 0
      ? "<p>None — every vector matched after normalization.</p>"
      : `<table>
      <tr><th>vector</th><th>field</th><th>expected (original)</th><th>actual (rebuild)</th></tr>
${rows}
    </table>`
  }
  <h2>Normalizers</h2>
  <ul>${normalizers}</ul>
  <div class="note"><strong>Honest scope:</strong> this score is a <em>behavioral</em> comparison on the
  listed vectors after the documented normalizations. It is not a formal proof of equivalence.</div>
</body>
</html>
`;
}

export interface VectorSet {
  id: string;
  targetId: string;
  vectors: Vector[];
  createdAt: string;
}

export interface Approval {
  token: string;
  specId: string;
  status: "pending" | "consumed";
  createdAt: string;
}

/** Pending human approval for a policy-gated ("ask") tool call. */
export interface ToolApproval {
  token: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: "pending" | "consumed";
  createdAt: string;
}

export interface ApprovalRequest {
  approvalRequired: true;
  approvalToken: string;
  tool: string;
  summary: string;
  hint: string;
}

export interface PackCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface PackVerification {
  valid: boolean;
  packId: string;
  checks: PackCheck[];
}

export interface Baseline {
  id: string;
  targetId: string;
  vectorSetId: string;
  reportId: string;
  score: number;
  pinnedAt: string;
}

function baselineId(targetId: string, vectorSetId: string): string {
  return (
    "base_" + createHash("sha256").update(`${targetId}\n${vectorSetId}`).digest("hex").slice(0, 16)
  );
}

export interface VectorDiffEntry {
  status: "added" | "removed" | "changed" | "unchanged";
  /** stable match key (input identity), not the random vector id */
  matchKey: string;
  idA?: string;
  idB?: string;
  /** field paths that differ, e.g. ["output.stdout"] */
  changes?: string[];
}

export interface VectorSetDiff {
  setA: string;
  setB: string;
  added: VectorDiffEntry[];
  removed: VectorDiffEntry[];
  changed: VectorDiffEntry[];
  unchanged: number;
}

/** What the evolve agent sees: behavior only, never the original binary. */
export interface EvolveAgentRequest {
  attempt: number;
  maxAttempts: number;
  targetScore: number;
  lastScore: number | null;
  synthesisContext: SynthesisContext;
  failingVectors: FailingVector[];
}

export interface EvolveAttempt {
  attempt: number;
  rebuildPath: string;
  score: number;
  failingVectorCount: number;
  durationMs: number;
  agentNotes?: string;
}

export interface EvolutionReport {
  id: string;
  specId: string;
  vectorSetId: string;
  targetScore: number;
  converged: boolean;
  bestScore: number;
  bestRebuildPath: string;
  bestReportId: string;
  attempts: EvolveAttempt[];
  startedAt: string;
  finishedAt: string;
}

/** Identity of a vector for diffing: what was asked, not what came back. */
function vectorMatchKey(v: Vector): string {
  const input = v.input;
  if (input.kind === "cli") {
    return `cli|${input.argv.join("\u0000")}|${input.stdin ?? ""}`;
  }
  const hdrs: Record<string, string> = input.headers ?? {};
  const headers = Object.keys(hdrs)
    .sort()
    .map((k) => `${k}=${hdrs[k]}`)
    .join("&");
  return `http|${input.method}|${input.url}|${headers}|${input.body ?? ""}`;
}

/** Deep field diff, dotted paths; id/recordedAt/seed are metadata, not behavior. */
function diffVectorFields(a: Vector, b: Vector): string[] {
  const changes: string[] = [];
  const skip = new Set(["id", "recordedAt", "seed"]);
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (x === y) return;
    if (
      x === null ||
      y === null ||
      typeof x !== "object" ||
      typeof y !== "object" ||
      Array.isArray(x) !== Array.isArray(y)
    ) {
      changes.push(path || "(root)");
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of [...keys].sort()) {
      if (path === "" && skip.has(k)) continue;
      walk(
        (x as Record<string, unknown>)[k],
        (y as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k
      );
    }
  };
  walk(a, b, "");
  if (a.weight !== b.weight && !changes.includes("weight")) changes.push("weight");
  return changes.sort();
}

/**
 * FeaCore — the 9 operations behind both the MCP tools and the CLI.
 * Every mutation appends to the hash-chained provenance log.
 */
export class FeaCore {
  private prov: ProvenanceLog;

  constructor(
    private store: FeaStore,
    private opts: { readerTransport?: Transport } = {}
  ) {
    this.prov = new ProvenanceLog(store.provenanceFile);
  }

  ingestTarget(input: { pathOrUrl: string; kind: TargetKind; iHaveRights: boolean }): TargetDescriptor {
    if (!input.iHaveRights) {
      throw new Error(
        "FEA requires explicit authorization: confirm you have the right to analyze this target " +
          "(you own it, it is open-source, or you are contracted/licensed to inspect it)."
      );
    }
    const target = describeTarget(input.pathOrUrl, input.kind);
    this.store.save("targets", target.id, target);
    this.prov.append("ingest", { target: target.id, kind: target.kind });
    return target;
  }

  async captureBehavior(input: {
    targetId: string;
    plans: Array<Record<string, unknown>>;
  }): Promise<{ vectorSetId: string; count: number }> {
    const target = this.store.load<TargetDescriptor>("targets", input.targetId);
    let vectors: Vector[];
    if (target.kind === "cli" || target.kind === "native") {
      vectors = await captureCli(
        target.pathOrUrl,
        input.plans.map((p) => ({
          name: p["name"] as string | undefined,
          argv: p["argv"] as string[],
          stdin: p["stdin"] as string | undefined,
          timeoutMs: p["timeoutMs"] as number | undefined
        }))
      );
    } else {
      vectors = await captureHttp(input.plans as unknown as HttpCapturePlan[]);
    }
    const set: VectorSet = {
      id: `vs_${randomUUID().slice(0, 8)}`,
      targetId: target.id,
      vectors,
      createdAt: new Date().toISOString()
    };
    this.store.save("vectorsets", set.id, set);
    this.prov.append("capture", { target: target.id, vectorset: set.id, count: vectors.length });
    return { vectorSetId: set.id, count: vectors.length };
  }

  /**
   * Ask the REA reader for analysis findings about a target.
   * Findings are stored as evidence (kind "reader-note") on the analysis
   * side. They never cross the clean-room firewall except as distilled
   * behavioral notes attached to a spec.
   */
  async readWithReader(input: {
    targetId: string;
    tool: string;
    args?: Record<string, unknown>;
    /** tool calls to run first, in the same reader session (e.g. open_binary) */
    prelude?: Array<{ tool: string; args?: Record<string, unknown> }>;
    readerCommand?: string[];
    readerUrl?: string;
    /** `fea reader serve` proxy URL (persistent session); alternative to readerCommand/readerUrl */
    readerProxyUrl?: string;
    readerToken?: string;
  }): Promise<ReaderNotes> {
    const target = this.store.load<TargetDescriptor>("targets", input.targetId);
    const reader = input.readerProxyUrl
      ? await ReaReader.connectRemote(input.readerProxyUrl, input.readerToken)
      : await ReaReader.connect({
          transport: this.opts.readerTransport,
          command: input.readerCommand,
          url: input.readerUrl
        });
    try {
      const prelude: Array<{ tool: string; summary: string }> = [];
      for (const p of input.prelude ?? []) {
        const r = await reader.callTool(p.tool, p.args ?? {});
        prelude.push({ tool: p.tool, summary: summarizeFindings(r) });
      }
      const result = await reader.callTool(input.tool, input.args ?? {});
      const { findings, truncated } = capFindings(result);
      const notes: ReaderNotes = {
        id: `note_${randomUUID().slice(0, 8)}`,
        targetId: target.id,
        reader: "rea",
        tool: input.tool,
        args: input.args ?? {},
        prelude: prelude.length > 0 ? prelude : undefined,
        summary: summarizeFindings(result),
        findings,
        truncated,
        createdAt: new Date().toISOString()
      };
      this.store.save("notes", notes.id, notes);
      this.prov.append("reader-read", {
        target: target.id,
        tool: input.tool,
        prelude: prelude.map((p) => p.tool),
        notes: notes.id,
        truncated
      });
      return notes;
    } finally {
      await reader.close();
    }
  }

  extractSpec(input: { vectorSetId: string; notesId?: string }): BehaviorSpec {
    const set = this.store.load<VectorSet>("vectorsets", input.vectorSetId);
    const target = this.store.load<TargetDescriptor>("targets", set.targetId);
    const spec = buildSpecFromVectors(target, set.vectors, `spec_${randomUUID().slice(0, 8)}`);
    if (input.notesId) {
      const notes = this.store.load<ReaderNotes>("notes", input.notesId);
      if (notes.targetId !== target.id) {
        throw new Error(`notes ${notes.id} belong to a different target`);
      }
      for (const s of spec.surfaces) {
        spec.evidence.push({
          itemId: s.name,
          kind: "reader-note",
          ref: `notes:${notes.id}#${notes.tool}`
        });
      }
    }
    const check = validateBehaviorSpec(spec);
    if (!check.ok) throw new Error(`spec invalid after notes: ${check.errors.join("; ")}`);
    this.store.save("specs", spec.id, spec);
    this.prov.append("spec", {
      spec: spec.id,
      surfaces: spec.surfaces.length,
      notes: input.notesId ?? null
    });
    return spec;
  }

  getSpec(input: { specId: string }): BehaviorSpec {
    const raw = this.store.load<unknown>("specs", input.specId);
    const result = validateBehaviorSpec(raw);
    if (!result.ok) throw new Error(`stored spec failed validation: ${result.errors.join("; ")}`);
    return result.spec;
  }

  planRebuild(input: { specId: string }): { plan: string[]; approvalToken: string; needsApproval: true } {
    const spec = this.getSpec(input);
    const plan = [
      `Read the synthesis context for ${spec.id} (firewalled behavior only).`,
      ...spec.surfaces.map(
        (s) => `Implement surface "${s.name}" (${s.kind}): ${s.signature} — ${s.ioExampleIds.length} I/O examples must pass.`
      ),
      `Run fea_verify_parity against the original until score is acceptable; attach failing vectors to the spec instead of guessing.`
    ];
    const approval: Approval = {
      token: `appr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      specId: spec.id,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    this.store.save("approvals", approval.token, approval);
    this.prov.append("plan-proposed", { spec: spec.id, token: approval.token.slice(0, 9) + "…" });
    return { plan, approvalToken: approval.token, needsApproval: true as const };
  }

  synthesisContext(input: { specId: string; approvalToken: string }): SynthesisContext {
    const approval = this.store.load<Approval>("approvals", input.approvalToken);
    if (approval.status !== "pending" || approval.specId !== input.specId) {
      throw new Error("invalid or already-consumed approval token — run fea_plan_rebuild first");
    }
    approval.status = "consumed";
    this.store.save("approvals", approval.token, approval);
    const spec = this.getSpec(input);
    const ctx = createSynthesisContext(spec);
    this.prov.append("firewall-pass", { spec: spec.id });
    return ctx;
  }

  async verifyParity(input: {
    originalTargetId: string;
    /** binary path for cli/native targets */
    rebuildPath?: string;
    /** base URL for http-api targets, e.g. http://127.0.0.1:3001 */
    rebuildUrl?: string;
    vectorSetId: string;
    seed?: string;
    /** CI mode: fail when score is below this threshold */
    failUnder?: number;
    /** named normalizer packs (http, log, path, ids), additive */
    packs?: string[];
  }): Promise<{
    report: ParityReport;
    passed: boolean;
    failUnder?: number;
    baseline?: { score: number; delta: number };
  }> {
    const target = this.store.load<TargetDescriptor>("targets", input.originalTargetId);
    const set = this.store.load<VectorSet>("vectorsets", input.vectorSetId);
    if (target.kind === "http-api" && !input.rebuildUrl) {
      throw new Error("http-api targets need rebuildUrl (the rebuild's base URL)");
    }
    if ((target.kind === "cli" || target.kind === "native") && !input.rebuildPath) {
      throw new Error("cli/native targets need rebuildPath (the rebuilt binary)");
    }
    if (target.kind === "apk") {
      throw new Error("apk parity needs a launched app harness — not in v0.5");
    }
    const report = await runParity({
      original: target.pathOrUrl,
      rebuild: input.rebuildPath,
      rebuildUrl: input.rebuildUrl,
      vectors: set.vectors,
      reportId: `rep_${randomUUID().slice(0, 8)}`,
      seed: input.seed,
      packs: input.packs
    });
    this.store.save("reports", report.id, report);
    const passed = input.failUnder === undefined ? true : report.score >= input.failUnder;
    let baseline: { score: number; delta: number } | undefined;
    try {
      const b = this.store.load<Baseline>("baselines", baselineId(target.id, set.id));
      baseline = { score: b.score, delta: Math.round((report.score - b.score) * 10) / 10 };
    } catch {
      // no baseline pinned — not an error
    }
    this.prov.append("verify", {
      report: report.id,
      score: report.score,
      failUnder: input.failUnder ?? null,
      baselineDelta: baseline?.delta ?? null,
      passed
    });
    return { report, passed, failUnder: input.failUnder, baseline };
  }

  /**
   * Pin a parity report as the baseline for a (target, vector set) pair.
   * Later verifyParity calls report the delta against it.
   */
  pinBaseline(input: { targetId: string; vectorSetId: string; reportId: string }): Baseline {
    const target = this.store.load<TargetDescriptor>("targets", input.targetId);
    this.store.load<VectorSet>("vectorsets", input.vectorSetId);
    const report = this.store.load<ParityReport>("reports", input.reportId);
    const baseline: Baseline = {
      id: baselineId(target.id, input.vectorSetId),
      targetId: target.id,
      vectorSetId: input.vectorSetId,
      reportId: report.id,
      score: report.score,
      pinnedAt: new Date().toISOString()
    };
    this.store.save("baselines", baseline.id, baseline);
    this.prov.append("pin", { baseline: baseline.id, score: baseline.score });
    return baseline;
  }

  /**
   * Diff two vector sets: which vectors were added, removed, or changed
   * (same input, different expectations/output), matched by input identity
   * so independently captured sets still line up.
   */
  diffVectorSets(input: { a: string; b: string }): VectorSetDiff {
    const setA = this.store.load<VectorSet>("vectorsets", input.a);
    const setB = this.store.load<VectorSet>("vectorsets", input.b);
    const group = (vs: Vector[]): Map<string, Vector[]> => {
      const m = new Map<string, Vector[]>();
      for (const v of vs) {
        const k = vectorMatchKey(v);
        const arr = m.get(k) ?? [];
        arr.push(v);
        m.set(k, arr);
      }
      return m;
    };
    const ga = group(setA.vectors);
    const gb = group(setB.vectors);
    const added: VectorDiffEntry[] = [];
    const removed: VectorDiffEntry[] = [];
    const changed: VectorDiffEntry[] = [];
    let unchanged = 0;
    for (const [key, listA] of ga) {
      const listB = gb.get(key) ?? [];
      const n = Math.max(listA.length, listB.length);
      for (let i = 0; i < n; i++) {
        const va = listA[i];
        const vb = listB[i];
        if (va && vb) {
          const changes = diffVectorFields(va, vb);
          if (changes.length === 0) unchanged++;
          else changed.push({ status: "changed", matchKey: key, idA: va.id, idB: vb.id, changes });
        } else if (va) {
          removed.push({ status: "removed", matchKey: key, idA: va.id });
        }
      }
      gb.delete(key);
    }
    for (const [key, listB] of gb) {
      for (const vb of listB) added.push({ status: "added", matchKey: key, idB: vb.id });
    }
    return { setA: setA.id, setB: setB.id, added, removed, changed, unchanged };
  }

  /**
   * The self-rebuilding loop. An external agent command is invoked once per
   * attempt with ONLY the firewalled synthesis context (behavior, never the
   * original binary) plus the previous attempt's failing vectors. The agent
   * prints {"rebuildPath": "..."} on stdout (logs go to stderr). FEA scores
   * each rebuild with the parity oracle until the target score is reached
   * or attempts run out. FEA is the reward function; the agent does the
   * writing.
   */
  async evolve(
    input: {
      specId: string;
      vectorSetId: string;
      agentCommand: string;
      agentArgs?: string[];
      targetScore?: number;
      maxAttempts?: number;
      attemptTimeoutMs?: number;
      packs?: string[];
    },
    onEvent?: (e: { attempt: number; score: number; converged: boolean }) => void | Promise<void>
  ): Promise<EvolutionReport> {
    const targetScore = input.targetScore ?? 100;
    const maxAttempts = input.maxAttempts ?? 5;
    const timeoutMs = input.attemptTimeoutMs ?? 300_000;
    const spec = this.store.load<BehaviorSpec>("specs", input.specId);
    const target = this.store.load<TargetDescriptor>("targets", spec.target.id);
    this.store.load<VectorSet>("vectorsets", input.vectorSetId);

    const ctx = createSynthesisContext(spec);
    // Defense in depth: fail closed if the original path ever leaks into the agent's view.
    if (target.pathOrUrl && JSON.stringify(ctx).includes(target.pathOrUrl)) {
      throw new Error("firewall breach: original target path leaked into synthesis context");
    }

    const startedAt = new Date().toISOString();
    const attempts: EvolveAttempt[] = [];
    let failingVectors: FailingVector[] = [];
    let lastScore: number | null = null;
    let best: { score: number; rebuildPath: string; reportId: string } | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const request: EvolveAgentRequest = {
        attempt,
        maxAttempts,
        targetScore,
        lastScore,
        synthesisContext: ctx,
        failingVectors
      };
      const attemptStarted = Date.now();
      const res = await new SpawnBackend().run(input.agentCommand, input.agentArgs ?? [], {
        stdin: JSON.stringify(request),
        timeoutMs,
        maxOutputBytes: 1_000_000
      });
      if (res.timedOut) {
        throw new Error(`evolve agent timed out after ${timeoutMs}ms (attempt ${attempt})`);
      }
      if (res.exitCode !== 0) {
        throw new Error(
          `evolve agent exited ${res.exitCode} (attempt ${attempt}): ${res.stderr.slice(0, 500)}`
        );
      }
      let parsed: { rebuildPath?: string; rebuildUrl?: string; notes?: string };
      try {
        parsed = JSON.parse(res.stdout) as typeof parsed;
      } catch {
        throw new Error(
          `evolve agent must print JSON {"rebuildPath": "..."} on stdout (attempt ${attempt}); got: ${res.stdout.slice(0, 200)}`
        );
      }
      if (!parsed.rebuildPath && !parsed.rebuildUrl) {
        throw new Error(`evolve agent did not return rebuildPath or rebuildUrl (attempt ${attempt})`);
      }
      const { report } = await this.verifyParity({
        originalTargetId: target.id,
        rebuildPath: parsed.rebuildPath,
        rebuildUrl: parsed.rebuildUrl,
        vectorSetId: input.vectorSetId,
        packs: input.packs
      });
      failingVectors = report.failingVectors;
      lastScore = report.score;
      attempts.push({
        attempt,
        rebuildPath: parsed.rebuildPath ?? parsed.rebuildUrl ?? "",
        score: report.score,
        failingVectorCount: failingVectors.length,
        durationMs: Date.now() - attemptStarted,
        agentNotes: parsed.notes
      });
      if (!best || report.score > best.score) {
        best = { score: report.score, rebuildPath: parsed.rebuildPath ?? parsed.rebuildUrl ?? "", reportId: report.id };
      }
      const converged = report.score >= targetScore;
      await onEvent?.({ attempt, score: report.score, converged });
      if (converged) break;
    }

    const evolution: EvolutionReport = {
      id: `evo_${randomUUID().slice(0, 8)}`,
      specId: spec.id,
      vectorSetId: input.vectorSetId,
      targetScore,
      converged: (best?.score ?? 0) >= targetScore,
      bestScore: best?.score ?? 0,
      bestRebuildPath: best?.rebuildPath ?? "",
      bestReportId: best?.reportId ?? "",
      attempts,
      startedAt,
      finishedAt: new Date().toISOString()
    };
    this.store.save("evolutions", evolution.id, evolution);
    this.prov.append("evolve", {
      evolution: evolution.id,
      converged: evolution.converged,
      bestScore: evolution.bestScore,
      attempts: attempts.length
    });
    return evolution;
  }

  /**
   * Watch a rebuild for changes and re-run parity on each change.
   * For binary rebuilds the fingerprint is mtime+size; for URL rebuilds
   * it's a hash of a GET on the base root (one request per poll).
   * Runs once immediately, then on every detected change until maxRuns.
   */
  async watchParity(
    input: {
      targetId: string;
      rebuildPath?: string;
      rebuildUrl?: string;
      vectorSetId: string;
      packs?: string[];
      failUnder?: number;
      pollMs?: number;
      maxRuns?: number;
    },
    onEvent: (e: {
      run: number;
      fingerprint: string;
      report: ParityReport;
      baselineDelta?: number;
      passed: boolean;
    }) => void | Promise<void>
  ): Promise<{ runs: number }> {
    const pollMs = input.pollMs ?? 2000;
    if (!input.rebuildPath && !input.rebuildUrl) {
      throw new Error("watch needs rebuildPath or rebuildUrl");
    }
    const fingerprintOf = async (): Promise<string> => {
      if (input.rebuildPath) {
        const st = statSync(input.rebuildPath);
        return `path:${st.mtimeMs}:${st.size}`;
      }
      const res = await fetch(input.rebuildUrl as string, { signal: AbortSignal.timeout(5000) });
      const body = await res.text();
      return `url:${res.status}:` + createHash("sha256").update(body).digest("hex").slice(0, 16);
    };

    let runs = 0;
    const doRun = async (fp: string): Promise<void> => {
      runs++;
      const { report, passed, baseline } = await this.verifyParity({
        originalTargetId: input.targetId,
        rebuildPath: input.rebuildPath,
        rebuildUrl: input.rebuildUrl,
        vectorSetId: input.vectorSetId,
        packs: input.packs,
        failUnder: input.failUnder
      });
      await onEvent({
        run: runs,
        fingerprint: fp,
        report,
        baselineDelta: baseline?.delta,
        passed
      });
    };

    let last = await fingerprintOf();
    await doRun(last);
    while (input.maxRuns === undefined || runs < input.maxRuns) {
      await new Promise((r) => setTimeout(r, pollMs));
      let fp: string;
      try {
        fp = await fingerprintOf();
      } catch {
        continue; // transient — try again next poll
      }
      if (fp !== last) {
        last = fp;
        await doRun(fp);
      }
    }
    return { runs };
  }

  /** Render a JUnit XML report for CI dashboards. */
  reportJunit(input: { reportId: string; outPath?: string }): { path: string } {
    const report = this.store.load<ParityReport>("reports", input.reportId);
    const out = input.outPath ?? join(this.store.dir, "reports", `${report.id}.junit.xml`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buildJunitXml(report));
    return { path: out };
  }

  exportPack(input: { specId: string; reportId: string }): { packDir: string; manifestSha256: string } {
    const spec = this.getSpec(input);
    const report = this.store.load<ParityReport>("reports", input.reportId);
    const packId = `pack_${createHash("sha256")
      .update(spec.id + report.id)
      .digest("hex")
      .slice(0, 12)}`;
    const packDir = join(this.store.packsDir, packId);
    mkdirSync(packDir, { recursive: true });

    const files: Record<string, string> = {};
    const put = (name: string, data: string) => {
      writeFileSync(join(packDir, name), data);
      files[name] = createHash("sha256").update(data).digest("hex");
    };
    put("spec.json", JSON.stringify(spec, null, 2));
    put("parity-report.json", JSON.stringify(report, null, 2));
    const provRaw = readFileSync(this.store.provenanceFile, "utf8");
    put("provenance.jsonl", provRaw);
    files["provenance.jsonl"] = createHash("sha256").update(provRaw).digest("hex");

    const manifest = {
      packId,
      feaVersion: FEA_VERSION,
      specId: spec.id,
      reportId: report.id,
      createdAt: new Date().toISOString(),
      files
    };
    const manifestRaw = JSON.stringify(manifest, null, 2);
    writeFileSync(join(packDir, "manifest.json"), manifestRaw);

    this.prov.append("pack", { pack: packId, spec: spec.id, report: report.id });
    return { packDir, manifestSha256: createHash("sha256").update(manifestRaw).digest("hex") };
  }

  /**
   * Verify an evidence pack: manifest integrity, file hashes, spec schema,
   * report identity, and the hash-chained provenance log. This is FEA
   * checking its own homework — a pack that fails here proves nothing.
   */
  verifyPack(input: { packPath: string }): PackVerification {
    const checks: PackCheck[] = [];
    const check = (name: string, ok: boolean, detail?: string): boolean => {
      checks.push({ name, ok, detail });
      return ok;
    };
    const done = (packId: string): PackVerification => ({
      valid: checks.every((c) => c.ok),
      packId,
      checks
    });

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(input.packPath, "manifest.json"), "utf8")) as Record<
        string,
        unknown
      >;
      check("manifest parses", true);
    } catch (e) {
      check("manifest parses", false, e instanceof Error ? e.message : String(e));
      return done("(unknown)");
    }

    const packId = typeof manifest["packId"] === "string" ? manifest["packId"] : "(unknown)";
    const files = manifest["files"];
    if (typeof manifest["specId"] !== "string" || typeof manifest["reportId"] !== "string" || typeof files !== "object" || files === null) {
      check("manifest has specId/reportId/files", false, "missing required fields");
      return done(packId);
    }
    check("manifest has specId/reportId/files", true);

    for (const [name, expected] of Object.entries(files as Record<string, unknown>)) {
      const path = join(input.packPath, name);
      if (!existsSync(path)) {
        check(`file present: ${name}`, false, "missing");
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
      check(`file intact: ${name}`, actual === expected, actual === expected ? undefined : "sha256 mismatch");
    }

    try {
      const spec = JSON.parse(readFileSync(join(input.packPath, "spec.json"), "utf8")) as BehaviorSpec;
      const res = validateBehaviorSpec(spec);
      check(
        "spec validates (BehaviorSpec v1)",
        res.ok,
        res.ok ? undefined : res.errors.slice(0, 3).join("; ")
      );
      check("spec id matches manifest", spec.id === manifest["specId"], `spec=${spec.id}`);
    } catch (e) {
      check("spec validates (BehaviorSpec v1)", false, e instanceof Error ? e.message : String(e));
    }

    try {
      const report = JSON.parse(readFileSync(join(input.packPath, "parity-report.json"), "utf8")) as {
        id: string;
      };
      check("report id matches manifest", report.id === manifest["reportId"], `report=${report.id}`);
    } catch (e) {
      check("report id matches manifest", false, e instanceof Error ? e.message : String(e));
    }

    try {
      const entries = parseProvenanceFile(readFileSync(join(input.packPath, "provenance.jsonl"), "utf8"));
      const chain = verifyProvenanceChain(entries);
      check(
        "provenance chain intact",
        chain.valid,
        chain.valid ? `${chain.entries} entries` : `broken at seq ${chain.brokenAt}: ${chain.reason}`
      );
    } catch (e) {
      check("provenance chain intact", false, e instanceof Error ? e.message : String(e));
    }

    return done(packId);
  }

  /**
   * Policy "ask" flow, step 1: stage a tool call for human approval.
   * Nothing executes yet. Step 2 is approveTool().
   */
  async requestToolApproval(tool: string, args: Record<string, unknown>): Promise<ApprovalRequest> {
    const summary = describeToolCall(tool, args);
    const approval: ToolApproval = {
      token: `tappr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      tool,
      args,
      summary,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    this.store.save("approvals", approval.token, approval);
    this.prov.append("tool-approval-requested", { tool, token: approval.token.slice(0, 12) + "…" });
    return {
      approvalRequired: true,
      approvalToken: approval.token,
      tool,
      summary,
      hint: "Approve with fea_approve (MCP) or `fea approve --token <token>` (CLI)."
    };
  }

  /** Policy "ask" flow, step 2: consume the token and execute the staged call. */
  async approveTool(input: { approvalToken: string }): Promise<unknown> {
    const ap = this.store.load<ToolApproval>("approvals", input.approvalToken);
    if (ap.status !== "pending" || !ap.tool) {
      throw new Error("approval token invalid or already consumed");
    }
    ap.status = "consumed";
    this.store.save("approvals", ap.token, ap);
    this.prov.append("tool-approved", { tool: ap.tool, token: ap.token.slice(0, 12) + "…" });
    switch (ap.tool) {
      case "fea_capture_behavior":
        return this.captureBehavior(ap.args as { targetId: string; plans: Array<Record<string, unknown>> });
      case "fea_verify_parity":
        return this.verifyParity(
          ap.args as {
            originalTargetId: string;
            rebuildPath?: string;
            rebuildUrl?: string;
            vectorSetId: string;
            seed?: string;
            failUnder?: number;
            packs?: string[];
          }
        );
      case "fea_read":
        return this.readWithReader(
          ap.args as {
            targetId: string;
            tool: string;
            args?: Record<string, unknown>;
            prelude?: Array<{ tool: string; args?: Record<string, unknown> }>;
            readerCommand?: string[];
            readerUrl?: string;
            readerProxyUrl?: string;
            readerToken?: string;
          }
        );
      default:
        throw new Error(`unknown tool in approval: ${ap.tool}`);
    }
  }

  /**
   * Generate deterministic fuzz vectors from a spec and store them as a new
   * vector set (recorded + generated). The oracle is differential, so the
   * generated vectors need no expected outputs.
   */
  fuzzVectors(input: { specId: string; count?: number; seed?: string }): {
    vectorSetId: string;
    generated: number;
  } {
    const spec = this.getSpec(input);
    const generated = generateVectors(spec, { count: input.count, seed: input.seed });
    const set: VectorSet = {
      id: `vs_fuzz_${randomUUID().slice(0, 8)}`,
      targetId: spec.target.id,
      vectors: [...spec.ioExamples, ...generated],
      createdAt: new Date().toISOString()
    };
    this.store.save("vectorsets", set.id, set);
    this.prov.append("fuzz", {
      spec: spec.id,
      vectorset: set.id,
      generated: generated.length,
      seed: input.seed ?? "fea"
    });
    return { vectorSetId: set.id, generated: generated.length };
  }

  /** Render a self-contained HTML parity report (no external assets). */
  reportHtml(input: { reportId: string; outPath?: string }): { path: string } {
    const report = this.store.load<ParityReport>("reports", input.reportId);
    const out = input.outPath ?? join(this.store.dir, "reports", `${report.id}.html`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buildReportHtml(report));
    this.prov.append("report", { report: report.id, path: out });
    return { path: out };
  }

  async doctor(): Promise<Record<string, string | boolean>> {
    const rea = await probeRea();
    const docker = await dockerAvailable();
    const android = await probeAndroidTools();
    let policySource: string;
    let policyValid = true;
    try {
      policySource = PolicyEngine.loadFor(this.store.dir).source;
    } catch {
      policyValid = false;
      policySource = "invalid policy file";
    }
    return {
      fea: FEA_VERSION,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      mcpSdk: "1.32.1",
      sandboxBackend: backendName(),
      dockerAvailable: docker,
      reaInstalled: rea.installed,
      reaVersion: rea.version ?? "(not installed)",
      policySource,
      policyValid,
      adbAvailable: android.adb,
      emulatorAvailable: android.emulator,
      time: new Date().toISOString()
    };
  }
}
