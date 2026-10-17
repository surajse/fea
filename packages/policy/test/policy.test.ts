import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { PolicyEngine, RECOMMENDED_POLICY } from "../src/index.js";

describe("PolicyEngine", () => {
  it("allows everything by default", () => {
    const p = new PolicyEngine({ version: "1.0" });
    expect(p.check("fea_anything")).toBe("allow");
    expect(p.source).toContain("allow-all");
  });

  it("honors per-tool rules", () => {
    const p = new PolicyEngine({
      version: "1.0",
      default: "allow",
      tools: { fea_read: "deny", fea_capture_behavior: "ask" }
    });
    expect(p.check("fea_read")).toBe("deny");
    expect(p.check("fea_capture_behavior")).toBe("ask");
    expect(p.check("fea_spec")).toBe("allow");
  });

  it("rejects invalid decisions", () => {
    expect(
      () => new PolicyEngine({ version: "1.0", tools: { x: "maybe" as never } })
    ).toThrow(/allow\|ask\|deny/);
  });

  it("rejects bad versions", () => {
    expect(() => new PolicyEngine({ version: "2.0" as never })).toThrow(/version/);
  });

  it("recommended policy gates execution tools", () => {
    const p = new PolicyEngine(RECOMMENDED_POLICY, "recommended");
    expect(p.check("fea_capture_behavior")).toBe("ask");
    expect(p.check("fea_verify_parity")).toBe("ask");
    expect(p.check("fea_read")).toBe("ask");
    expect(p.check("fea_get_spec")).toBe("allow");
  });

  describe("loadFor", () => {
    const saved = process.env.FEA_POLICY;
    afterEach(() => {
      if (saved === undefined) delete process.env.FEA_POLICY;
      else process.env.FEA_POLICY = saved;
    });

    it("loads from an explicit file", () => {
      const dir = mkdtempSync(join(tmpdir(), "fea-"));
      const file = join(dir, "policy.json");
      writeFileSync(file, JSON.stringify({ version: "1.0", tools: { fea_read: "deny" } }));
      const p = PolicyEngine.loadFor(dir, file);
      expect(p.check("fea_read")).toBe("deny");
      expect(p.source).toContain(file);
    });

    it("loads from <storeDir>/fea.policy.json", () => {
      const dir = mkdtempSync(join(tmpdir(), "fea-"));
      writeFileSync(
        join(dir, "fea.policy.json"),
        JSON.stringify({ version: "1.0", default: "deny" })
      );
      const p = PolicyEngine.loadFor(dir);
      expect(p.check("fea_anything")).toBe("deny");
    });

    it("falls back to allow-all", () => {
      const p = PolicyEngine.loadFor(mkdtempSync(join(tmpdir(), "fea-")));
      expect(p.check("fea_anything")).toBe("allow");
    });

    it("prefers FEA_POLICY env", () => {
      const dir = mkdtempSync(join(tmpdir(), "fea-"));
      const file = join(dir, "env-policy.json");
      writeFileSync(file, JSON.stringify({ version: "1.0", tools: { fea_read: "ask" } }));
      process.env.FEA_POLICY = file;
      const p = PolicyEngine.loadFor(mkdtempSync(join(tmpdir(), "fea-")));
      expect(p.check("fea_read")).toBe("ask");
    });
  });
});
