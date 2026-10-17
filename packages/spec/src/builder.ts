import { randomUUID } from "node:crypto";
import type { BehaviorSpec, Surface, TargetDescriptor, Vector } from "./schema.js";
import { validateBehaviorSpec } from "./schema.js";

/**
 * Build a draft BehaviorSpec from captured vectors.
 * CLI vectors are grouped by argv[0] into surfaces; every surface and
 * vector gets an evidence ref pointing at the capture. Pure function.
 */
export function buildSpecFromVectors(
  target: TargetDescriptor,
  vectors: Vector[],
  specId = `spec_${randomUUID().slice(0, 8)}`
): BehaviorSpec {
  if (vectors.length === 0) {
    throw new Error("buildSpecFromVectors: need at least one vector");
  }

  const surfaces: Surface[] = [];
  const first = vectors[0];
  if (first.input.kind === "cli") {
    const groups = new Map<string, Vector[]>();
    for (const v of vectors) {
      if (v.input.kind !== "cli" || v.output.kind !== "cli") {
        throw new Error("buildSpecFromVectors: mixed vector kinds are not supported in v0.1");
      }
      const key = v.input.argv[0] ?? "(no-args)";
      const list = groups.get(key) ?? [];
      list.push(v);
      groups.set(key, list);
    }
    for (const [name, vs] of groups) {
      surfaces.push({
        name,
        kind: "cli-command",
        signature: `${target.pathOrUrl.split("/").pop()} ${name} [...args]`,
        description: `Observed CLI surface "${name}" (${vs.length} recorded examples).`,
        ioExampleIds: vs.map((v) => v.id)
      });
    }
  } else {
    const groups = new Map<string, Vector[]>();
    for (const v of vectors) {
      if (v.input.kind !== "http" || v.output.kind !== "http") {
        throw new Error("buildSpecFromVectors: mixed vector kinds are not supported in v0.1");
      }
      const key = `${v.input.method} ${new URL(v.input.url).pathname}`;
      const list = groups.get(key) ?? [];
      list.push(v);
      groups.set(key, list);
    }
    for (const [name, vs] of groups) {
      surfaces.push({
        name,
        kind: "http-endpoint",
        signature: name,
        description: `Observed HTTP surface "${name}" (${vs.length} recorded examples).`,
        ioExampleIds: vs.map((v) => v.id)
      });
    }
  }

  const candidate = {
    id: specId,
    version: "1.0",
    target,
    surfaces,
    dataModels: [],
    invariants: [],
    ioExamples: vectors,
    evidence: [
      ...surfaces.map((s) => ({
        itemId: s.name,
        kind: "capture" as const,
        ref: `vectors:${s.ioExampleIds.join(",")}`
      })),
      ...vectors.map((v) => ({
        itemId: v.id,
        kind: "capture" as const,
        ref: `vector:${v.id}`
      }))
    ]
  };

  const result = validateBehaviorSpec(candidate);
  if (!result.ok) {
    throw new Error(`buildSpecFromVectors produced invalid spec: ${result.errors.join("; ")}`);
  }
  return result.spec;
}
