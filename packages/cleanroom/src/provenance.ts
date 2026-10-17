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

export interface ChainVerification {
  valid: boolean;
  entries: number;
  /** seq of the first broken entry, if any */
  brokenAt?: number;
  reason?: string;
}

function hashEntry(prevHash: string, body: { seq: number; ts: string; event: string; data: Record<string, unknown> }): string {
  return createHash("sha256").update(prevHash + canonical(body)).digest("hex");
}

/**
 * Pure hash-chain verification over parsed entries. Reports the first
 * broken entry instead of a bare boolean, so callers can say *what*
 * was tampered with.
 */
export function verifyProvenanceChain(entries: ProvenanceEntry[]): ChainVerification {
  let prev = "GENESIS";
  for (const e of entries) {
    if (typeof e.seq !== "number" || typeof e.hash !== "string" || typeof e.prevHash !== "string") {
      return { valid: false, entries: entries.length, brokenAt: e.seq, reason: "malformed entry" };
    }
    if (e.prevHash !== prev) {
      return {
        valid: false,
        entries: entries.length,
        brokenAt: e.seq,
        reason: `prevHash mismatch (expected link to ${prev.slice(0, 12)}…)`
      };
    }
    const recomputed = hashEntry(e.prevHash, { seq: e.seq, ts: e.ts, event: e.event, data: e.data });
    if (recomputed !== e.hash) {
      return {
        valid: false,
        entries: entries.length,
        brokenAt: e.seq,
        reason: "entry hash mismatch (data was modified)"
      };
    }
    prev = e.hash;
  }
  return { valid: true, entries: entries.length };
}

/** Parse a provenance.jsonl file into entries (throws on malformed JSON). */
export function parseProvenanceFile(raw: string): ProvenanceEntry[] {
  const text = raw.trim();
  if (!text) return [];
  return text.split("\n").map((line, i) => {
    try {
      return JSON.parse(line) as ProvenanceEntry;
    } catch {
      throw new Error(`provenance line ${i} is not valid JSON`);
    }
  });
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
    return verifyProvenanceChain(this.readAll()).valid;
  }

  get path(): string {
    return this.file;
  }
}
