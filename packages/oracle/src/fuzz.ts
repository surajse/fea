import type { BehaviorSpec, Vector } from "@fea/spec";

/** xfnv1a — string seed to uint32. */
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FuzzOptions {
  seed?: string;
  /** how many generated vectors (default 20) */
  count?: number;
}

type Mutation = (rand: () => number) => string[];

const ARG_MUTATIONS: Mutation[] = [
  () => [],
  () => ["--help"],
  () => ["-h"],
  () => ["--version"],
  () => [""],
  () => [" "],
  () => ["0"],
  () => ["-0"],
  () => ["-1"],
  (r) => [String(Math.floor(r() * 1e6))],
  (r) => [String(-Math.floor(r() * 1e6))],
  () => ["999999999999999999999"],
  () => ["3.14"],
  () => ["-3.14"],
  () => ["NaN"],
  () => ["Infinity"],
  () => ["-Infinity"],
  () => ["0x10"],
  () => ["1e3"],
  () => ["1,000"],
  () => ["héllo"],
  () => ["x".repeat(500)],
  () => ["\t"],
  (r) => Array.from({ length: 1 + Math.floor(r() * 5) }, () => String(Math.floor(r() * 1000))),
  (r) => [String(Math.floor(r() * 10)), "", "42"]
];

/**
 * Generate deterministic CLI vectors from a spec's surfaces.
 * v0.3 supports CLI surfaces only (native binaries share the CLI shape).
 * Generated vectors weigh 1 (recorded weigh 2). The `output` is a
 * placeholder — the oracle is differential (original vs rebuild on the
 * same inputs), so recorded outputs are never used as expected values.
 * Deduplicates against recorded vectors and within the generated set.
 */
export function generateVectors(spec: BehaviorSpec, opts: FuzzOptions = {}): Vector[] {
  const surfaces = spec.surfaces.filter((s) => s.kind === "cli-command");
  if (surfaces.length === 0) {
    throw new Error("fuzz v0.3 supports CLI surfaces only");
  }
  const seed = opts.seed ?? "fea";
  const count = opts.count ?? 20;
  const rand = mulberry32(hashSeed(seed));

  const seen = new Set<string>(
    spec.ioExamples
      .filter((v) => v.input.kind === "cli")
      .map((v) => (v.input.kind === "cli" ? v.input.argv.join("\u0000") : ""))
  );

  const out: Vector[] = [];
  let guard = 0;
  while (out.length < count && guard < count * 100) {
    guard++;
    const surface = surfaces[Math.floor(rand() * surfaces.length)];
    const mutate = ARG_MUTATIONS[Math.floor(rand() * ARG_MUTATIONS.length)];
    const argv = [surface.name, ...mutate(rand)];
    const key = argv.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `vec_fuzz_${out.length + 1}`,
      weight: 1,
      input: { kind: "cli", argv },
      output: { kind: "cli", stdout: "", stderr: "", exitCode: 0 },
      recordedAt: new Date().toISOString(),
      seed
    });
  }
  return out;
}
