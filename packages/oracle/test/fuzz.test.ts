import { describe, expect, it } from "vitest";
import { generateVectors } from "../src/fuzz.js";
import { buildSpecFromVectors } from "@fea/spec";
import { cliVectors, target } from "../../spec/test/fixtures.js";

describe("generateVectors", () => {
  it("is deterministic for the same seed", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_fuzz");
    const a = generateVectors(spec, { seed: "s1", count: 15 });
    const b = generateVectors(spec, { seed: "s1", count: 15 });
    // recordedAt is wall-clock; determinism covers the vectors themselves
    const strip = (vs: typeof a) => vs.map(({ recordedAt: _r, ...rest }) => rest);
    expect(strip(a)).toEqual(strip(b));
  });

  it("differs across seeds", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_fuzz");
    const a = generateVectors(spec, { seed: "s1", count: 15 });
    const b = generateVectors(spec, { seed: "s2", count: 15 });
    expect(a).not.toEqual(b);
  });

  it("respects count, weight and seed fields", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_fuzz");
    const vs = generateVectors(spec, { seed: "abc", count: 10 });
    expect(vs).toHaveLength(10);
    for (const v of vs) {
      expect(v.weight).toBe(1);
      expect(v.seed).toBe("abc");
      expect(v.input.kind).toBe("cli");
    }
  });

  it("never duplicates recorded vectors", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_fuzz");
    const recorded = new Set(
      spec.ioExamples.map((v) => (v.input.kind === "cli" ? v.input.argv.join(" ") : ""))
    );
    const vs = generateVectors(spec, { seed: "dup", count: 30 });
    for (const v of vs) {
      if (v.input.kind === "cli") {
        expect(recorded.has(v.input.argv.join(" "))).toBe(false);
      }
    }
    // and no duplicates within the generated set
    const keys = vs.map((v) => (v.input.kind === "cli" ? v.input.argv.join(" ") : ""));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes boundary mutations", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_fuzz");
    const vs = generateVectors(spec, { seed: "bounds", count: 60 });
    const argvs = vs.map((v) => (v.input.kind === "cli" ? v.input.argv.join(" ") : ""));
    const blob = argvs.join("\n");
    expect(blob).toContain("--help");
    expect(blob).toContain("NaN");
  });

  it("rejects specs without CLI surfaces", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_fuzz");
    const httpOnly = { ...spec, surfaces: [] };
    expect(() => generateVectors(httpOnly)).toThrow(/CLI surfaces only/);
  });
});
