import { runCommand } from "@fea/sandbox";
import type { Vector } from "@fea/spec";
import { applyNormalizers, defaultNormalizers, type Normalizer } from "./normalize.js";
import { normalizersFor } from "./packs.js";

export interface FailingVector {
  vectorId: string;
  field: "stdout" | "stderr" | "exitCode";
  expected: string;
  actual: string;
}

export interface ParityReport {
  id: string;
  original: string;
  rebuild: string;
  /** 0–100, one decimal; weighted by vector weight */
  score: number;
  passed: number;
  failed: number;
  total: number;
  weightPassed: number;
  weightTotal: number;
  failingVectors: FailingVector[];
  normalizers: Normalizer[];
  generatedAt: string;
  seed: string;
}

export interface ParityOptions {
  original: string;
  rebuild: string;
  vectors: Vector[];
  timeoutMs?: number;
  seed?: string;
  reportId?: string;
  normalizers?: Normalizer[];
  /** named normalizer packs, additive on top of `normalizers` */
  packs?: string[];
}

/**
 * Differential parity: run original and rebuild on every vector, compare
 * normalized outputs. v0.1 supports CLI vectors; HTTP parity is v0.2.
 * This is behavioral comparison, NOT a proof of equivalence — the report
 * says exactly what was compared.
 */
export async function runParity(opts: ParityOptions): Promise<ParityReport> {
  const base = opts.normalizers ?? defaultNormalizers;
  const normalizers = [...normalizersFor(opts.packs ?? []), ...base];
  let passed = 0;
  let failed = 0;
  let weightPassed = 0;
  let weightTotal = 0;
  const failingVectors: FailingVector[] = [];

  for (const v of opts.vectors) {
    if (v.input.kind !== "cli" || v.output.kind !== "cli") {
      throw new Error(`oracle v0.1 supports CLI vectors only (vector "${v.id}")`);
    }
    weightTotal += v.weight;

    const [a, b] = await Promise.all([
      runCommand(opts.original, v.input.argv, {
        stdin: v.input.stdin,
        timeoutMs: opts.timeoutMs
      }),
      runCommand(opts.rebuild, v.input.argv, {
        stdin: v.input.stdin,
        timeoutMs: opts.timeoutMs
      })
    ]);

    const checks: Array<["stdout" | "stderr" | "exitCode", string, string]> = [
      ["stdout", applyNormalizers(a.stdout, normalizers), applyNormalizers(b.stdout, normalizers)],
      ["stderr", applyNormalizers(a.stderr, normalizers), applyNormalizers(b.stderr, normalizers)],
      ["exitCode", String(a.exitCode), String(b.exitCode)]
    ];

    let ok = true;
    for (const [field, expected, actual] of checks) {
      if (expected !== actual) {
        ok = false;
        failingVectors.push({
          vectorId: v.id,
          field,
          expected: expected.slice(0, 500),
          actual: actual.slice(0, 500)
        });
      }
    }
    if (ok) {
      passed += 1;
      weightPassed += v.weight;
    } else {
      failed += 1;
    }
  }

  const total = passed + failed;
  const score = weightTotal > 0 ? Math.round((1000 * weightPassed) / weightTotal) / 10 : 0;

  return {
    id: opts.reportId ?? `rep_${Date.now().toString(36)}`,
    original: opts.original,
    rebuild: opts.rebuild,
    score,
    passed,
    failed,
    total,
    weightPassed,
    weightTotal,
    failingVectors,
    normalizers,
    generatedAt: new Date().toISOString(),
    seed: opts.seed ?? "default"
  };
}
