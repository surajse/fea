import { describe, expect, it } from "vitest";
import { validateBehaviorSpec } from "../src/schema.js";
import { minimalSpec } from "./fixtures.js";

describe("validateBehaviorSpec", () => {
  it("accepts a valid spec", () => {
    const result = validateBehaviorSpec(minimalSpec());
    expect(result.ok).toBe(true);
  });

  it("rejects a spec with a dangling vector reference", () => {
    const spec = minimalSpec();
    spec.surfaces[0].ioExampleIds = ["nope"];
    const result = validateBehaviorSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("unknown vector");
    }
  });

  it("rejects a spec with dangling evidence", () => {
    const spec = minimalSpec();
    spec.evidence.push({ itemId: "ghost", kind: "manual", ref: "x" });
    const result = validateBehaviorSpec(spec);
    expect(result.ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateBehaviorSpec(null).ok).toBe(false);
    expect(validateBehaviorSpec("spec").ok).toBe(false);
  });
});
