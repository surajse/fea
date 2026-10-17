import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { TargetDescriptor, TargetKind } from "@fea/spec";

/**
 * Register a target. v0.1: CLI binaries (file hash) and HTTP APIs
 * (hash of the base URL + capture plan identity).
 */
export function describeTarget(pathOrUrl: string, kind: TargetKind): TargetDescriptor {
  let sha256: string;
  if (kind === "cli") {
    const st = statSync(pathOrUrl);
    if (!st.isFile()) throw new Error(`describeTarget: not a file: ${pathOrUrl}`);
    sha256 = createHash("sha256").update(readFileSync(pathOrUrl)).digest("hex");
  } else {
    sha256 = createHash("sha256").update(`http-api:${pathOrUrl}`).digest("hex");
  }
  return {
    id: `tgt_${sha256.slice(0, 8)}`,
    kind,
    pathOrUrl,
    sha256,
    capturedAt: new Date().toISOString()
  };
}
