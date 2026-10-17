import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ProvenanceEntry {
  seq: number;
  ts: string;
  event: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashEntry(prevHash: string, body: { seq: number; ts: string; event: string; data: Record<string, unknown> }): string {
  return createHash("sha256").update(prevHash + canonical(body)).digest("hex");
}

/**
 * Append-only, hash-chained provenance log (JSONL). Every pipeline step
 * (ingest, capture, spec, firewall-pass, plan approval, synthesis,
 * verify, pack) appends an entry. `verify()` detects any tampering.
 */
export class ProvenanceLog {
  private file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, "");
  }

  private readAll(): ProvenanceEntry[] {
    const raw = readFileSync(this.file, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line) as ProvenanceEntry);
  }

  append(event: string, data: Record<string, unknown> = {}): ProvenanceEntry {
    const entries = this.readAll();
    const prevHash = entries.length > 0 ? entries[entries.length - 1].hash : "GENESIS";
    const body = { seq: entries.length, ts: new Date().toISOString(), event, data };
    const entry: ProvenanceEntry = { ...body, prevHash, hash: hashEntry(prevHash, body) };
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
    return entry;
  }

  verify(): boolean {
    const entries = this.readAll();
    let prev = "GENESIS";
    for (const e of entries) {
      if (e.prevHash !== prev) return false;
      if (hashEntry(e.prevHash, { seq: e.seq, ts: e.ts, event: e.event, data: e.data }) !== e.hash) {
        return false;
      }
      prev = e.hash;
    }
    return true;
  }

  get path(): string {
    return this.file;
  }
}
