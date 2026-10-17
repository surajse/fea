import { runCommand } from "@fea/sandbox";
import type { Vector } from "@fea/spec";
import { applyNormalizers, defaultNormalizers, type Normalizer } from "./normalize.js";
import {
  canonicalizeJson,
  JSON_CANONICALIZER,
  JSON_PACK,
  normalizersFor
} from "./packs.js";

export interface FailingVector {
  vectorId: string;
  field: "stdout" | "stderr" | "exitCode" | "status" | "headers" | "body";
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
  /** ids of vectors that passed (for exact per-vector reporting) */
  passedVectorIds: string[];
  weightPassed: number;
  weightTotal: number;
  failingVectors: FailingVector[];
  normalizers: Normalizer[];
  generatedAt: string;
  seed: string;
}

export interface ParityOptions {
  original: string;
  /** binary path for CLI/native vectors */
  rebuild?: string;
  /** base URL for HTTP vectors, e.g. http://127.0.0.1:3001 */
  rebuildUrl?: string;
  vectors: Vector[];
  timeoutMs?: number;
  seed?: string;
  reportId?: string;
  normalizers?: Normalizer[];
  /** named normalizer packs, additive on top of `normalizers` */
  packs?: string[];
}

/** Replay an HTTP vector against a base: same path+query, swapped origin. */
export function swapOrigin(recordedUrl: string, base: string): string {
  if (/^https?:\/\//i.test(recordedUrl)) {
    const u = new URL(recordedUrl);
    const b = new URL(base);
    return `${b.origin}${u.pathname}${u.search}`;
  }
  return new URL(recordedUrl, base).toString();
}

export interface HttpReplay {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function replayHttp(
  base: string,
  input: { method: string; url: string; headers?: Record<string, string>; body?: string },
  timeoutMs = 10_000
): Promise<HttpReplay> {
  const res = await fetch(swapOrigin(input.url, base), {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body: await res.text() };
}

/** Canonical form for header comparison: sorted "k: v" lines. */
export function canonicalHeaders(headers: Record<string, string>): string {
  return Object.keys(headers)
    .sort()
    .map((k) => `${k.toLowerCase()}: ${headers[k]}`)
    .join("\n");
}

/**
 * Run a single vector's input against a rebuild and return its raw output.
 * Used by `fea promote` (bless the rebuild's behavior as the new expected).
 * No normalization — promote records what the rebuild actually did.
 */
export async function runVectorOutput(
  rebuildPathOrUrl: string,
  vector: Vector,
  timeoutMs = 10_000
): Promise<Vector["output"]> {
  if (vector.input.kind === "cli") {
    const r = await runCommand(rebuildPathOrUrl, vector.input.argv, {
      stdin: vector.input.stdin,
      timeoutMs
    });
    return { kind: "cli", stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }
  const r = await replayHttp(rebuildPathOrUrl, vector.input, timeoutMs);
  return { kind: "http", status: r.status, headers: r.headers, body: r.body };
}

/**
 * Differential parity: run original and rebuild on every vector, compare
 * normalized outputs. Supports CLI/native vectors (binary paths) and HTTP
 * vectors (base URLs). Mixed sets are allowed; each kind needs its rebuild
 * (rebuild for CLI, rebuildUrl for HTTP).
 * This is behavioral comparison, NOT a proof of equivalence — the report
 * says exactly what was compared.
 */
export async function runParity(opts: ParityOptions): Promise<ParityReport> {
  const packNames = opts.packs ?? [];
  const useJson = packNames.includes(JSON_PACK);
  const base = opts.normalizers ?? defaultNormalizers;
  const applied = [...normalizersFor(packNames.filter((p) => p !== JSON_PACK)), ...base];
  // The report lists everything that shaped the comparison, including the
  // structural JSON canonicalizer.
  const normalizers = useJson ? [JSON_CANONICALIZER, ...applied] : applied;
  const normalize = (t: string): string =>
    applyNormalizers(useJson ? canonicalizeJson(t) : t, applied);
  let passed = 0;
  let failed = 0;
  let weightPassed = 0;
  let weightTotal = 0;
  const failingVectors: FailingVector[] = [];
  const passedVectorIds: string[] = [];

  for (const v of opts.vectors) {
    weightTotal += v.weight;
    const checks = await checkVector(v, opts, normalize);

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
      passedVectorIds.push(v.id);
    } else {
      failed += 1;
    }
  }

  const total = passed + failed;
  const score = weightTotal > 0 ? Math.round((1000 * weightPassed) / weightTotal) / 10 : 0;

  return {
    id: opts.reportId ?? `rep_${Date.now().toString(36)}`,
    original: opts.original,
    rebuild: opts.rebuild ?? opts.rebuildUrl ?? "(none)",
    score,
    passed,
    failed,
    total,
    passedVectorIds,
    weightPassed,
    weightTotal,
    failingVectors,
    normalizers,
    generatedAt: new Date().toISOString(),
    seed: opts.seed ?? "default"
  };
}

type Check = [FailingVector["field"], string, string];

async function checkVector(
  v: Vector,
  opts: ParityOptions,
  normalize: (t: string) => string
): Promise<Check[]> {
  if (v.input.kind === "cli" && v.output.kind === "cli") {
    if (!opts.rebuild) {
      throw new Error(`CLI vector "${v.id}" needs a rebuild binary path (rebuild)`);
    }
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
    return [
      ["stdout", normalize(a.stdout), normalize(b.stdout)],
      ["stderr", normalize(a.stderr), normalize(b.stderr)],
      ["exitCode", String(a.exitCode), String(b.exitCode)]
    ];
  }
  if (v.input.kind === "http" && v.output.kind === "http") {
    if (!opts.rebuildUrl) {
      throw new Error(`HTTP vector "${v.id}" needs a rebuild base URL (rebuildUrl)`);
    }
    const [a, b] = await Promise.all([
      replayHttp(opts.original, v.input, opts.timeoutMs),
      replayHttp(opts.rebuildUrl, v.input, opts.timeoutMs)
    ]);
    return [
      ["status", String(a.status), String(b.status)],
      ["headers", normalize(canonicalHeaders(a.headers)), normalize(canonicalHeaders(b.headers))],
      ["body", normalize(a.body), normalize(b.body)]
    ];
  }
  throw new Error(`mismatched vector input/output kinds (vector "${v.id}")`);
}
