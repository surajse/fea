import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  probeAndroidTools
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
import { generateVectors, runParity, type ParityReport } from "@fea/oracle";
import { PolicyEngine } from "@fea/policy";
import { FeaStore } from "./store.js";
import { dirname } from "node:path";

export const FEA_VERSION = "0.6.0";

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
  }): Promise<{ report: ParityReport; passed: boolean; failUnder?: number }> {
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
    this.prov.append("verify", {
      report: report.id,
      score: report.score,
      failUnder: input.failUnder ?? null,
      passed
    });
    return { report, passed, failUnder: input.failUnder };
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
