import { z } from "zod";

/**
 * BehaviorSpec v1 — the machine-checkable contract describing OBSERVABLE
 * behavior of a target. It must never describe implementation internals
 * (no decompiled code, no addresses, no symbols). The cleanroom package
 * enforces this at the firewall.
 */

export const TargetKind = z.enum(["cli", "http-api"]);
export type TargetKind = z.infer<typeof TargetKind>;

export const TargetDescriptor = z.object({
  id: z.string().min(1),
  kind: TargetKind,
  /** absolute file path (cli) or base URL (http-api) */
  pathOrUrl: z.string().min(1),
  /** sha256 of the binary file, or of the capture plan for http-api */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.string().datetime()
});
export type TargetDescriptor = z.infer<typeof TargetDescriptor>;

const CliVectorInput = z.object({
  kind: z.literal("cli"),
  argv: z.array(z.string()),
  stdin: z.string().optional()
});
const HttpVectorInput = z.object({
  kind: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional()
});
export const VectorInput = z.discriminatedUnion("kind", [CliVectorInput, HttpVectorInput]);
export type VectorInput = z.infer<typeof VectorInput>;

const CliVectorOutput = z.object({
  kind: z.literal("cli"),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int()
});
const HttpVectorOutput = z.object({
  kind: z.literal("http"),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string()
});
export const VectorOutput = z.discriminatedUnion("kind", [CliVectorOutput, HttpVectorOutput]);
export type VectorOutput = z.infer<typeof VectorOutput>;

export const Vector = z.object({
  id: z.string().min(1),
  /** recorded vectors weigh 2x in parity scoring; generated weigh 1x */
  weight: z.number().positive().default(2),
  input: VectorInput,
  output: VectorOutput,
  recordedAt: z.string().datetime(),
  seed: z.string().optional()
});
export type Vector = z.infer<typeof Vector>;

export const Surface = z.object({
  name: z.string().min(1),
  kind: z.enum(["cli-command", "http-endpoint", "library-function"]),
  /** human-readable signature, e.g. `adder <numbers...> [--help]` */
  signature: z.string().min(1),
  description: z.string().optional(),
  ioExampleIds: z.array(z.string()).min(1)
});
export type Surface = z.infer<typeof Surface>;

export const DataModel = z.object({
  name: z.string().min(1),
  fields: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) }))
});
export type DataModel = z.infer<typeof DataModel>;

export const Invariant = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  vectorIds: z.array(z.string())
});
export type Invariant = z.infer<typeof Invariant>;

export const EvidenceRef = z.object({
  /** id of the spec item this evidence supports (surface name, vector id, ...) */
  itemId: z.string().min(1),
  kind: z.enum(["capture", "reader-note", "manual"]),
  ref: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional()
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const BehaviorSpec = z
  .object({
    id: z.string().min(1),
    version: z.literal("1.0"),
    target: TargetDescriptor,
    surfaces: z.array(Surface).min(1),
    dataModels: z.array(DataModel).default([]),
    invariants: z.array(Invariant).default([]),
    ioExamples: z.array(Vector).min(1),
    evidence: z.array(EvidenceRef).min(1)
  })
  .superRefine((spec, ctx) => {
    const vectorIds = new Set(spec.ioExamples.map((v) => v.id));
    for (const s of spec.surfaces) {
      for (const id of s.ioExampleIds) {
        if (!vectorIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `surface "${s.name}" references unknown vector "${id}"`
          });
        }
      }
    }
    const itemIds = new Set<string>([
      ...spec.surfaces.map((s) => s.name),
      ...spec.ioExamples.map((v) => v.id),
      ...spec.invariants.map((i) => i.id),
      ...spec.dataModels.map((d) => d.name)
    ]);
    for (const e of spec.evidence) {
      if (!itemIds.has(e.itemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `evidence references unknown item "${e.itemId}"`
        });
      }
    }
  });
export type BehaviorSpec = z.infer<typeof BehaviorSpec>;

export type ValidationResult =
  | { ok: true; spec: BehaviorSpec }
  | { ok: false; errors: string[] };

/** Validate unknown data as a BehaviorSpec. Deterministic — no LLM involved. */
export function validateBehaviorSpec(data: unknown): ValidationResult {
  const parsed = BehaviorSpec.safeParse(data);
  if (parsed.success) return { ok: true, spec: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
    )
  };
}
