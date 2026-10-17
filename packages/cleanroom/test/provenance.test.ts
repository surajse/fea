import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProvenanceLog } from "../src/provenance.js";

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
