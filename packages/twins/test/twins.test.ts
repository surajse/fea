import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTwinEntry,
  compareTwinVersions,
  FileTwinIndex,
  type TwinEntry
} from "../src/index.js";

const SHA = "a".repeat(64);

function entry(over: Partial<TwinEntry> = {}): TwinEntry {
  return buildTwinEntry({
    name: "wc-twin",
    version: "1.0.0",
    targetFingerprint: SHA,
    targetKind: "cli",
    parityScore: 100,
    specId: "spec_1",
    packSha256: SHA,
    feaVersion: "1.0.0",
    ...over
  });
}

describe("buildTwinEntry", () => {
  it("builds a valid entry", () => {
    const e = entry({ description: "word count twin" });
    expect(e.name).toBe("wc-twin");
    expect(e.publishedAt).toBeTruthy();
  });

  it("rejects bad names, versions, and hashes", () => {
    expect(() => entry({ name: "Bad Name!" })).toThrow(/invalid twin name/);
    expect(() => entry({ version: "v1" })).toThrow(/invalid twin version/);
    expect(() => entry({ targetFingerprint: "zzz" })).toThrow(/sha256/);
  });
});

describe("compareTwinVersions", () => {
  it("orders semver numerically", () => {
    expect(compareTwinVersions("1.0.0", "1.0.10")).toBeLessThan(0);
    expect(compareTwinVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareTwinVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("FileTwinIndex", () => {
  it("round-trips add/find/search, latest version wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "fea-twins-"));
    const index = new FileTwinIndex(join(dir, "index.json"));
    expect(index.search("wc")).toHaveLength(0);

    index.add(entry({ version: "1.0.0", description: "word count twin" }));
    index.add(entry({ version: "1.1.0", description: "word count twin, faster" }));
    index.add(entry({ name: "echo-twin", version: "1.0.0", description: "echo twin" }));

    expect(index.find("wc-twin")?.version).toBe("1.1.0");
    expect(index.find("wc-twin", "1.0.0")?.version).toBe("1.0.0");
    expect(index.find("nope")).toBeUndefined();
    expect(index.search("word count")).toHaveLength(2);
    expect(index.search("ECHO")).toHaveLength(1);

    // upsert replaces same name+version
    index.add(entry({ version: "1.0.0", description: "updated" }));
    expect(index.find("wc-twin", "1.0.0")?.description).toBe("updated");
  });

  it("rejects a corrupt index", () => {
    const dir = mkdtempSync(join(tmpdir(), "fea-twins-"));
    const p = join(dir, "index.json");
    writeFileSync(p, JSON.stringify({ twins: "nope" }));
    expect(() => new FileTwinIndex(p).read()).toThrow(/corrupt/);
  });
});
