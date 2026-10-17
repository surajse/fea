import { describe, expect, it } from "vitest";
import { canonicalizeJson, normalizersFor, listPacks, PACKS } from "../src/packs.js";
import { applyNormalizers } from "../src/normalize.js";

describe("normalizer packs", () => {
  it("lists the known packs", () => {
    expect(listPacks().sort()).toEqual(["ansi", "http", "ids", "json", "log", "path"].sort());
    for (const name of listPacks()) {
      expect(PACKS[name].description.length).toBeGreaterThan(0);
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

  it("ansi pack strips color codes", () => {
    const out = applyNormalizers("[32mok[0m [1mbold[0m", normalizersFor(["ansi"]));
    expect(out).toBe("ok bold");
  });

  it("json pack is structural (no regex normalizers)", () => {
    expect(normalizersFor(["json"])).toEqual([]);
  });
});

describe("canonicalizeJson", () => {
  it("sorts keys and normalizes whitespace", () => {
    expect(canonicalizeJson('{ "b": 2, "a": 1 }')).toBe('{"a":1,"b":2}');
  });

  it("sorts nested keys and arrays", () => {
    expect(canonicalizeJson('{"z": {"b":1,"a":2}, "l": [3,2]}')).toBe(
      '{"l":[3,2],"z":{"a":2,"b":1}}'
    );
  });

  it("leaves non-JSON text untouched", () => {
    expect(canonicalizeJson("hello world")).toBe("hello world");
    expect(canonicalizeJson('{"broken":')).toBe('{"broken":');
  });
});
