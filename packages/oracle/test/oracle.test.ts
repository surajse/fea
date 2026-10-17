import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyNormalizers, runParity } from "../src/index.js";
import type { Vector } from "@fea/spec";

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fea-"));
  const file = join(dir, "tool.js");
  writeFileSync(file, body);
  return file;
}

/**
 * An executable proxy: runs `target` with the same argv and forwards
 * stdio/exit code. Lets runParity compare two DIFFERENT programs while
 * both sides receive identical argv.
 */
function proxy(target: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fea-"));
  const file = join(dir, "proxy.js");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const r = spawnSync(process.execPath, [${JSON.stringify(target)}, ...process.argv.slice(2)], { encoding: "utf8" });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
`
  );
  chmodSync(file, 0o755);
  return file;
}

const ADDER = `const ns = process.argv.slice(2).map(Number);
if (ns.some(isNaN)) { console.error("not a number"); process.exit(1); }
console.log(ns.reduce((a, b) => a + b, 0));`;

function vec(id: string, argv: string[], stdout: string, stderr = "", exitCode = 0): Vector {
  return {
    id,
    weight: 2,
    input: { kind: "cli", argv },
    output: { kind: "cli", stdout, stderr, exitCode },
    recordedAt: new Date().toISOString()
  };
}

describe("runParity", () => {
  it("scores 100 when both sides behave identically", async () => {
    const good = script(ADDER);
    const report = await runParity({
      original: proxy(good),
      rebuild: proxy(good),
      vectors: [vec("v1", ["2", "3"], "5\n"), vec("v2", ["x"], "", "not a number\n", 1)]
    });
    expect(report.total).toBe(2);
    expect(report.score).toBe(100);
    expect(report.failingVectors).toHaveLength(0);
  });

  it("flags real behavioral differences with failing vectors", async () => {
    const good = script(ADDER);
    const buggy = script(ADDER.replace("a + b", "a + b + 1"));
    const report = await runParity({
      original: proxy(good),
      rebuild: proxy(buggy),
      vectors: [vec("v1", ["2", "3"], "5\n"), vec("v2", ["10"], "10\n")]
    });
    expect(report.score).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.failingVectors[0]).toMatchObject({ vectorId: "v1", field: "stdout" });
    expect(report.failingVectors[0].expected).toContain("5");
    // buggy script adds +1 per reduce step: (0+2+1)=3, (3+3+1)=7
    expect(report.failingVectors[0].actual).toContain("7");
  });

  it("normalizes timestamps inside the pipeline", async () => {
    const stamper = script(`console.log("done at " + new Date().toISOString());`);
    const report = await runParity({
      original: proxy(stamper),
      rebuild: proxy(stamper),
      vectors: [vec("v1", [], "")]
    });
    expect(report.score).toBe(100);
  });

  it("rejects mismatched vector input/output kinds", async () => {
    const good = script(ADDER);
    await expect(
      runParity({
        original: proxy(good),
        rebuild: proxy(good),
        vectors: [
          {
            id: "v1",
            weight: 1,
            input: { kind: "http", method: "GET", url: "http://x" },
            output: { kind: "cli", stdout: "", stderr: "", exitCode: 0 },
            recordedAt: new Date().toISOString()
          }
        ]
      })
    ).rejects.toThrow(/mismatched vector/);
  });
});

describe("applyNormalizers", () => {
  it("normalizes timestamps but keeps real differences", () => {
    const a = applyNormalizers("done at 2026-10-17T08:00:00.000Z ok");
    const b = applyNormalizers("done at 2026-10-17T09:12:33.000Z ok");
    expect(a).toBe(b);
    expect(a).toContain("<TIMESTAMP>");
    expect(applyNormalizers("error 42")).not.toBe(applyNormalizers("error 43"));
  });
});
