export interface Normalizer {
  name: string;
  /** regex source, applied with `flags` */
  pattern: string;
  flags: string;
  replacement: string;
}

/**
 * Default normalizers: ignore differences that are not behavior —
 * timestamps, temp paths, durations. Everything else must match byte
 * for byte. Normalizers are part of the parity report (auditable).
 */
export const defaultNormalizers: Normalizer[] = [
  {
    name: "iso-timestamp",
    pattern: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})?",
    flags: "g",
    replacement: "<TIMESTAMP>"
  },
  {
    name: "tmp-path",
    pattern: "/tmp/[A-Za-z0-9._-]+",
    flags: "g",
    replacement: "<TMP>"
  },
  {
    name: "duration-ms",
    pattern: "\\b\\d+(\\.\\d+)?ms\\b",
    flags: "g",
    replacement: "<DURATION>"
  }
];

export function applyNormalizers(text: string, normalizers: Normalizer[] = defaultNormalizers): string {
  let out = text;
  for (const n of normalizers) {
    out = out.replace(new RegExp(n.pattern, n.flags), n.replacement);
  }
  return out;
}
