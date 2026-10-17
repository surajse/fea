import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProvenanceLog,
  parseProvenanceFile,
  verifyProvenanceChain
} from "../src/provenance.js";

describe("ProvenanceLog", () => {
  it("appends and verifies a chain", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fea-")), "prov.jsonl");
    const log = new ProvenanceLog(file);
    log.append("ingest", { target: "tgt_1" });
    log.append("capture", { vectors: 3 });
    log.append("verify", { score: 100 });
    expect(log.verify()).toBe(true);
  });

  it("detects tampering", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fea-")), "prov.jsonl");
    const log = new ProvenanceLog(file);
    log.append("ingest", { target: "tgt_1" });
    appendFileSync(file, JSON.stringify({ seq: 99, fake: true }) + "\n");
    expect(log.verify()).toBe(false);
  });
});

describe("verifyProvenanceChain", () => {
  function chainedLog(): string {
    const file = join(mkdtempSync(join(tmpdir(), "fea-")), "prov.jsonl");
    const log = new ProvenanceLog(file);
    log.append("ingest", { target: "tgt_1" });
    log.append("capture", { vectors: 3 });
    log.append("verify", { score: 100 });
    return readFileSync(file, "utf8");
  }

  it("validates a genuine chain with entry count", () => {
    const entries = parseProvenanceFile(chainedLog());
    const res = verifyProvenanceChain(entries);
    expect(res.valid).toBe(true);
    expect(res.entries).toBe(3);
    expect(res.brokenAt).toBeUndefined();
  });

  it("pinpoints modified data", () => {
    const lines = chainedLog().trim().split("\n");
    const tampered = JSON.parse(lines[1]) as Record<string, unknown>;
    tampered["data"] = { vectors: 999 };
    lines[1] = JSON.stringify(tampered);
    const res = verifyProvenanceChain(parseProvenanceFile(lines.join("\n")));
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(1);
    expect(res.reason).toMatch(/modified/);
  });

  it("pinpoints a broken link", () => {
    const lines = chainedLog().trim().split("\n");
    const broken = JSON.parse(lines[2]) as Record<string, unknown>;
    broken["prevHash"] = "tampered";
    lines[2] = JSON.stringify(broken);
    const res = verifyProvenanceChain(parseProvenanceFile(lines.join("\n")));
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(2);
    expect(res.reason).toMatch(/prevHash/);
  });

  it("rejects malformed entries", () => {
    const res = verifyProvenanceChain([{ seq: 0, nope: true } as never]);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/malformed/);
  });

  it("parseProvenanceFile rejects bad JSON lines", () => {
    expect(() => parseProvenanceFile('{"seq":0}\nnot json\n')).toThrow(/line 1/);
  });

  it("an empty log is valid", () => {
    expect(verifyProvenanceChain(parseProvenanceFile(""))).toEqual({
      valid: true,
      entries: 0
    });
  });
});
