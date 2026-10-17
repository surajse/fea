import type { BehaviorSpec } from "@fea/spec";

export interface SynthesisExample {
  id: string;
  input: unknown;
  output: unknown;
}

export interface SynthesisSurface {
  name: string;
  kind: string;
  signature: string;
  description?: string;
  ioExamples: SynthesisExample[];
}

export interface SynthesisContext {
  specId: string;
  version: "1.0";
  surfaces: SynthesisSurface[];
  dataModels: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
  invariants: Array<{ id: string; description: string }>;
  /** rules the synthesis agent must follow */
  rules: string[];
}

/**
 * Any key that smells like implementation internals must NEVER cross the
 * firewall. The scan is deliberately broad: false positives are safe
 * (they get renamed), false negatives are the legal risk.
 */
const FORBIDDEN_KEY_PATTERN =
  /(decompil|pseudocode|assembly|disassembl|\baddress\b|symbols?|rawbytes|rawcapture|binarydump|opcode|controlflow|cfg\b)/i;

export class CleanroomLeakError extends Error {
  constructor(public paths: string[]) {
    super(`clean-room leak detected at: ${paths.join(", ")}`);
    this.name = "CleanroomLeakError";
  }
}

/** Deep-scan an object for forbidden keys; throw listing every hit. */
export function assertNoForbiddenKeys(value: unknown, path = "$"): void {
  const leaks: string[] = [];
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (FORBIDDEN_KEY_PATTERN.test(k)) leaks.push(`${p}.${k}`);
        walk(val, `${p}.${k}`);
      }
    }
  };
  walk(value, path);
  if (leaks.length > 0) throw new CleanroomLeakError(leaks);
}

/**
 * Build the synthesis context from a validated spec using a strict
 * whitelist projection. Only observable behavior crosses the wall:
 * signatures, I/O examples, data shapes, invariants. Decompiled code,
 * addresses, symbols and raw captures can never pass — they are not even
 * readable from the returned structure.
 */
export function createSynthesisContext(spec: BehaviorSpec): SynthesisContext {
  const byId = new Map(spec.ioExamples.map((v) => [v.id, v]));
  const surfaces: SynthesisSurface[] = spec.surfaces.map((s) => ({
    name: s.name,
    kind: s.kind,
    signature: s.signature,
    description: s.description,
    ioExamples: s.ioExampleIds.map((id) => {
      const v = byId.get(id);
      if (!v) throw new Error(`spec references unknown vector "${id}"`);
      return { id: v.id, input: v.input, output: v.output };
    })
  }));

  const ctx: SynthesisContext = {
    specId: spec.id,
    version: "1.0",
    surfaces,
    dataModels: spec.dataModels.map((d) => ({
      name: d.name,
      fields: d.fields.map((f) => ({ name: f.name, type: f.type }))
    })),
    invariants: spec.invariants.map((i) => ({ id: i.id, description: i.description })),
    rules: [
      "Reimplement OBSERVED BEHAVIOR ONLY. Never guess at internals.",
      "Every surface must be covered by its I/O examples; a surface with no example is out of scope.",
      "Match exit codes, stdout bytes and stderr bytes exactly unless a documented normalizer covers the difference.",
      "When in doubt, add a failing vector to the spec instead of guessing."
    ]
  };

  // Belt and suspenders: the projection itself must pass the leak scan.
  assertNoForbiddenKeys(ctx);
  return ctx;
}
