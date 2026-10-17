import { describe, expect, it } from "vitest";
import { normalizersFor, listPacks, PACKS } from "../src/packs.js";
import { applyNormalizers } from "../src/normalize.js";

describe("normalizer packs", () => {
  it("lists the known packs", () => {
    expect(listPacks().sort()).toEqual(["http", "ids", "log", "path"].sort());
    for (const name of listPacks()) {
      expect(PACKS[name].normalizers.length).toBeGreaterThan(0);
    }
  });

  it("throws on unknown pack names", () => {
    expect(() => normalizersFor(["nope"])).toThrow(/unknown normalizer pack/);
  });

  it("http pack normalizes RFC1123 dates", () => {
    const out = applyNormalizers(
      "Date: Wed, 21 Oct 2015 07:28:00 GMT",
      normalizersFor(["http"])
    );
    expect(out).toBe("Date: <HTTP-DATE>");
  });

  it("log pack normalizes datetimes and pids", () => {
    const out = applyNormalizers(
      "[2026-10-17 09:14:22] pid=1234 started",
      normalizersFor(["log"])
    );
    expect(out).toBe("[<LOG-TS>] pid=<PID> started");
  });

  it("ids pack normalizes UUIDs", () => {
    const out = applyNormalizers(
      "id=550e8400-e29b-41d4-a716-446655440000",
      normalizersFor(["ids"])
    );
    expect(out).toBe("id=<UUID>");
  });

  it("path pack normalizes temp and home dirs", () => {
    const out = applyNormalizers(
      "wrote /tmp/fea-abc123/out to /home/suraj/x",
      normalizersFor(["path"])
    );
    expect(out).toBe("wrote <TMP>/out to <HOME>/x");
  });

  it("packs are additive, not overlapping the defaults", () => {
    const names = normalizersFor(["http", "log"]).map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
