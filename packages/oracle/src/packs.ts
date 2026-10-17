import type { Normalizer } from "./normalize.js";

export interface NormalizerPack {
  name: string;
  description: string;
  normalizers: Normalizer[];
}

/**
 * Named normalizer packs for common non-behavioral noise. Packs are
 * additive on top of the default normalizers; every applied normalizer
 * is listed in the parity report (auditable).
 */
export const PACKS: Record<string, NormalizerPack> = {
  http: {
    name: "http",
    description: "HTTP noise: RFC1123 dates, ETags, server tokens",
    normalizers: [
      {
        name: "http-date",
        pattern:
          "\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4} \\d{2}:\\d{2}:\\d{2} GMT\\b",
        flags: "g",
        replacement: "<HTTP-DATE>"
      },
      {
        name: "etag",
        pattern: "\\bETag: \"[^\"]+\"",
        flags: "g",
        replacement: 'ETag: "<ETAG>"'
      },
      {
        name: "server-token",
        pattern: "\\bServer: [^\\r\\n]+",
        flags: "g",
        replacement: "Server: <SERVER>"
      }
    ]
  },
  log: {
    name: "log",
    description: "Log noise: timestamps, pids, thread ids",
    normalizers: [
      {
        name: "log-datetime",
        pattern: "\\b\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}(\\.\\d+)?\\b",
        flags: "g",
        replacement: "<LOG-TS>"
      },
      {
        name: "pid",
        pattern: "\\bpid[=:]\\d+\\b",
        flags: "gi",
        replacement: "pid=<PID>"
      },
      {
        name: "thread-id",
        pattern: "\\btid[=:]\\d+\\b",
        flags: "gi",
        replacement: "tid=<TID>"
      }
    ]
  },
  path: {
    name: "path",
    description: "Ephemeral paths: temp dirs, home dirs, ports",
    normalizers: [
      {
        name: "tmp-dir",
        pattern: "/tmp/[A-Za-z0-9._-]+",
        flags: "g",
        replacement: "<TMP>"
      },
      {
        name: "home-dir",
        pattern: "/home/[A-Za-z0-9._-]+",
        flags: "g",
        replacement: "<HOME>"
      },
      {
        name: "ephemeral-port",
        pattern: ":(?:[4-5]\\d{4}|[6-9]\\d{4})\\b",
        flags: "g",
        replacement: ":<PORT>"
      }
    ]
  },
  ids: {
    name: "ids",
    description: "Random identifiers: UUIDs, hex tokens",
    normalizers: [
      {
        name: "uuid",
        pattern: "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b",
        flags: "gi",
        replacement: "<UUID>"
      },
      {
        name: "hex-token",
        pattern: "\\b[0-9a-f]{32,}\\b",
        flags: "gi",
        replacement: "<HEX>"
      }
    ]
  },
  ansi: {
    name: "ansi",
    description: "Terminal escape codes: colors, cursor movement",
    normalizers: [
      {
        name: "ansi-csi",
        pattern: "\\u001b\\[[0-9;?]*[a-zA-Z]",
        flags: "g",
        replacement: ""
      },
      {
        name: "ansi-osc",
        pattern: "\\u001b\\][^\\u0007]*\\u0007",
        flags: "g",
        replacement: ""
      }
    ]
  },
  json: {
    name: "json",
    description: "Canonicalize whole-body JSON: parse, sort keys, re-stringify (handled structurally, not by regex)",
    normalizers: []
  }
};

export function listPacks(): string[] {
  return Object.keys(PACKS);
}

/** Pack name for structural JSON canonicalization (not regex-based). */
export const JSON_PACK = "json";

/** Synthetic report entry so the json pack stays auditable. */
export const JSON_CANONICALIZER: Normalizer = {
  name: "json-canonicalize",
  pattern: "<whole-body JSON: parse, sort keys, re-stringify>",
  flags: "",
  replacement: "<canonical JSON>"
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeys(obj[k])]));
  }
  return value;
}

/**
 * If the whole (trimmed) text parses as JSON, re-stringify with sorted
 * keys and normalized whitespace. Anything else passes through untouched.
 */
export function canonicalizeJson(text: string): string {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) return text;
  try {
    return JSON.stringify(sortKeys(JSON.parse(trimmed)));
  } catch {
    return text;
  }
}

/** Flatten pack names to normalizers; throws on unknown pack names. */
export function normalizersFor(packs: string[]): Normalizer[] {
  const out: Normalizer[] = [];
  for (const name of packs) {
    const pack = PACKS[name];
    if (!pack) {
      throw new Error(`unknown normalizer pack "${name}" (known: ${listPacks().join(", ")})`);
    }
    out.push(...pack.normalizers);
  }
  return out;
}
