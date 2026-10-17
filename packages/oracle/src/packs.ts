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
  }
};

export function listPacks(): string[] {
  return Object.keys(PACKS);
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
