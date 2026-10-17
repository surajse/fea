import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A published verified twin: an index entry pointing at an evidence pack.
 * The index never holds binaries — only metadata + a pointer to the pack.
 * `targetFingerprint` identifies WHAT was twinned (sha256 of the original),
 * never the original itself.
 */
export interface TwinEntry {
  name: string;
  version: string;
  description?: string;
  targetFingerprint: string;
  targetKind: string;
  parityScore: number;
  specId: string;
  /** sha256 of the pack's manifest.json bytes — re-checked on `twin get` */
  packSha256: string;
  /** where the pack lives: local dir path, file:// URL, or https:// URL to a .tar.gz */
  packLocation?: string;
  publishedAt: string;
  publisher?: string;
  feaVersion: string;
}

export interface TwinIndexFile {
  version: 1;
  updatedAt: string;
  twins: TwinEntry[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9a-zA-Z.-]+)?$/;

export function assertValidTwinName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid twin name "${name}" (lowercase letters, digits, -, _)`);
  }
}

export function assertValidTwinVersion(version: string): void {
  if (!VERSION_RE.test(version)) {
    throw new Error(`invalid twin version "${version}" (semver, e.g. 1.0.0)`);
  }
}

/** Numeric semver-ish compare; unknown segments compare as strings. */
export function compareTwinVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i] ?? "";
    const xb = pb[i] ?? "";
    const na = Number(xa);
    const nb = Number(xb);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && xa !== "" && xb !== "") {
      if (na !== nb) return na - nb;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

export interface BuildTwinEntryInput {
  name: string;
  version: string;
  description?: string;
  targetFingerprint: string;
  targetKind: string;
  parityScore: number;
  specId: string;
  packSha256: string;
  packLocation?: string;
  publisher?: string;
  feaVersion: string;
}

export function buildTwinEntry(input: BuildTwinEntryInput): TwinEntry {
  assertValidTwinName(input.name);
  assertValidTwinVersion(input.version);
  if (!/^[0-9a-f]{64}$/.test(input.targetFingerprint)) {
    throw new Error("targetFingerprint must be a sha256 hex string");
  }
  if (!/^[0-9a-f]{64}$/.test(input.packSha256)) {
    throw new Error("packSha256 must be a sha256 hex string");
  }
  return {
    name: input.name,
    version: input.version,
    description: input.description,
    targetFingerprint: input.targetFingerprint,
    targetKind: input.targetKind,
    parityScore: input.parityScore,
    specId: input.specId,
    packSha256: input.packSha256,
    packLocation: input.packLocation,
    publishedAt: new Date().toISOString(),
    publisher: input.publisher,
    feaVersion: input.feaVersion
  };
}

/**
 * File-backed twin index: `{ version: 1, updatedAt, twins: [...] }`.
 * v1.0's registry backend. A GitHub-backed index (surajse/fea-twins) speaks
 * the same TwinEntry shape — swap the backend, keep the entries.
 */
export class FileTwinIndex {
  constructor(readonly indexPath: string) {}

  read(): TwinIndexFile {
    if (!existsSync(this.indexPath)) {
      return { version: 1, updatedAt: new Date().toISOString(), twins: [] };
    }
    const raw = JSON.parse(readFileSync(this.indexPath, "utf8")) as Partial<TwinIndexFile>;
    if (!Array.isArray(raw.twins)) throw new Error(`twin index is corrupt: ${this.indexPath}`);
    return { version: 1, updatedAt: raw.updatedAt ?? new Date().toISOString(), twins: raw.twins };
  }

  write(index: TwinIndexFile): void {
    mkdirSync(dirname(this.indexPath), { recursive: true });
    writeFileSync(
      this.indexPath,
      JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 2)
    );
  }

  /** Insert or replace by (name, version). */
  add(entry: TwinEntry): void {
    const index = this.read();
    const i = index.twins.findIndex((t) => t.name === entry.name && t.version === entry.version);
    if (i >= 0) index.twins[i] = entry;
    else index.twins.push(entry);
    this.write(index);
  }

  /** Latest version when `version` is omitted. */
  find(name: string, version?: string): TwinEntry | undefined {
    const matches = this.read().twins.filter((t) => t.name === name);
    if (version) return matches.find((t) => t.version === version);
    return matches.sort((a, b) => compareTwinVersions(b.version, a.version))[0];
  }

  search(query: string): TwinEntry[] {
    const q = query.toLowerCase();
    return this.read().twins.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q) ||
        t.targetKind.toLowerCase().includes(q)
    );
  }
}
