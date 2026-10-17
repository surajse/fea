import { describe, expect, it } from "vitest";
import { ManualHarness, probeAndroidTools } from "../src/harness.js";

describe("ManualHarness", () => {
  it("holds a base URL", async () => {
    const h = new ManualHarness("http://127.0.0.1:8080");
    expect(h.name).toBe("manual");
    expect(h.baseUrl).toBe("http://127.0.0.1:8080");
    await h.close();
  });

  it("rejects non-HTTP URLs", () => {
    expect(() => new ManualHarness("not-a-url")).toThrow(/http\(s\)/);
  });
});

describe("probeAndroidTools", () => {
  it("returns a shape, whatever the machine has", async () => {
    const res = await probeAndroidTools();
    expect(typeof res.adb).toBe("boolean");
    expect(typeof res.emulator).toBe("boolean");
  });
});
