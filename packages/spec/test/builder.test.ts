import { describe, expect, it } from "vitest";
import { buildSpecFromVectors } from "../src/builder.js";
import { validateBehaviorSpec } from "../src/schema.js";
import { cliVectors, target } from "./fixtures.js";

describe("buildSpecFromVectors", () => {
  it("groups CLI vectors by argv[0] into surfaces", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_demo");
    expect(spec.surfaces.map((s) => s.name)).toEqual(["add", "--help"]);
    expect(validateBehaviorSpec(spec).ok).toBe(true);
  });

  it("throws on empty vectors", () => {
    expect(() => buildSpecFromVectors(target, [])).toThrow(/at least one vector/);
  });

  it("attaches evidence for every surface and vector", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_demo");
    const itemIds = new Set(spec.evidence.map((e) => e.itemId));
    for (const s of spec.surfaces) expect(itemIds.has(s.name)).toBe(true);
    for (const v of spec.ioExamples) expect(itemIds.has(v.id)).toBe(true);
  });
});
