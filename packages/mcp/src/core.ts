import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSpecFromVectors,
  validateBehaviorSpec,
  type BehaviorSpec,
  type TargetDescriptor,
  type TargetKind,
  type Vector
} from "@fea/spec";
import { captureCli, captureHttp, describeTarget, type HttpCapturePlan } from "@fea/readers";
import { createSynthesisContext, ProvenanceLog, type SynthesisContext } from "@fea/cleanroom";
import { runParity, type ParityReport } from "@fea/oracle";
import { FeaStore } from "./store.js";

export const FEA_VERSION = "0.1.0";

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

/**
 * FeaCore — the 9 operations behind both the MCP tools and the CLI.
 * Every mutation appends to the hash-chained provenance log.
 */
export class FeaCore {
  private prov: ProvenanceLog;

  constructor(private store: FeaStore) {
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
    if (target.kind === "cli") {
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

  extractSpec(input: { vectorSetId: string }): BehaviorSpec {
    const set = this.store.load<VectorSet>("vectorsets", input.vectorSetId);
    const target = this.store.load<TargetDescriptor>("targets", set.targetId);
    const spec = buildSpecFromVectors(target, set.vectors, `spec_${randomUUID().slice(0, 8)}`);
    this.store.save("specs", spec.id, spec);
    this.prov.append("spec", { spec: spec.id, surfaces: spec.surfaces.length });
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
    rebuildPath: string;
    vectorSetId: string;
    seed?: string;
  }): Promise<ParityReport> {
    const target = this.store.load<TargetDescriptor>("targets", input.originalTargetId);
    const set = this.store.load<VectorSet>("vectorsets", input.vectorSetId);
    const report = await runParity({
      original: target.pathOrUrl,
      rebuild: input.rebuildPath,
      vectors: set.vectors,
      reportId: `rep_${randomUUID().slice(0, 8)}`,
      seed: input.seed
    });
    this.store.save("reports", report.id, report);
    this.prov.append("verify", { report: report.id, score: report.score });
    return report;
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

  doctor(): Record<string, string> {
    return {
      fea: FEA_VERSION,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      mcpSdk: "1.32.1",
      time: new Date().toISOString()
    };
  }
}
