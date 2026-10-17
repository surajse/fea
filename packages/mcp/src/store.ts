import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Tiny JSON file-store under one directory (default: ./.fea). */
export class FeaStore {
  constructor(public dir: string) {
    for (const sub of ["targets", "vectorsets", "specs", "reports", "approvals", "packs"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
  }

  save(kind: string, id: string, data: unknown): string {
    const file = join(this.dir, kind, `${id}.json`);
    writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  }

  load<T>(kind: string, id: string): T {
    const file = join(this.dir, kind, `${id}.json`);
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      throw new Error(`unknown ${kind} id: "${id}"`);
    }
  }

  get provenanceFile(): string {
    return join(this.dir, "provenance.jsonl");
  }

  get packsDir(): string {
    return join(this.dir, "packs");
  }
}
