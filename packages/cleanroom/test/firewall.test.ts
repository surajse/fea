import { describe, expect, it } from "vitest";
import {
  CleanroomLeakError,
  assertNoForbiddenKeys,
  createSynthesisContext
} from "../src/firewall.js";
import { buildSpecFromVectors } from "@fea/spec";
import { cliVectors, target } from "../../spec/test/fixtures.js";

describe("assertNoForbiddenKeys", () => {
  it("passes clean objects", () => {
    expect(() => assertNoForbiddenKeys({ a: 1, nested: { b: [1, 2] } })).not.toThrow();
  });

  it("throws on forbidden keys, even nested", () => {
    expect(() =>
      assertNoForbiddenKeys({ ok: true, deep: { pseudocode: "int main(){}" } })
    ).toThrow(CleanroomLeakError);
  });

  it("lists every offending path", () => {
    try {
      assertNoForbiddenKeys({ assembly: "mov", x: { symbols: [] } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CleanroomLeakError);
      expect((e as CleanroomLeakError).paths).toEqual(["$.assembly", "$.x.symbols"]);
    }
  });
});

describe("createSynthesisContext", () => {
  it("projects only whitelisted behavior fields", () => {
    const spec = buildSpecFromVectors(target, cliVectors(), "spec_ctx");
    // simulate a spec object polluted with analysis junk (as `any`)
    const polluted = JSON.parse(JSON.stringify(spec));
    polluted.surfaces[0].decompiledHint = "int add(int,int)";
    const ctx = createSynthesisContext(polluted as never);
    expect(ctx.specId).toBe("spec_ctx");
    expect("decompiledHint" in (ctx.surfaces[0] as object)).toBe(false);
    expect(ctx.surfaces[0].ioExamples).toHaveLength(2);
    expect(ctx.rules.length).toBeGreaterThan(0);
  });
});
