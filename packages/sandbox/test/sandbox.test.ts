import { describe, expect, it } from "vitest";
import { runCommand } from "../src/index.js";

const NODE = process.execPath;

describe("runCommand", () => {
  it("captures stdout, stderr and exit code", async () => {
    const r = await runCommand(NODE, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);"
    ]);
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("err");
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it("feeds stdin", async () => {
    const r = await runCommand(
      NODE,
      ["-e", "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()));"],
      { stdin: "hello" }
    );
    expect(r.stdout).toBe("HELLO");
  });

  it("kills on timeout", async () => {
    const r = await runCommand(NODE, ["-e", "setTimeout(()=>{}, 30_000);"], {
      timeoutMs: 300
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  });

  it("truncates large output", async () => {
    const r = await runCommand(NODE, ["-e", "process.stdout.write('x'.repeat(100_000));"], {
      maxOutputBytes: 1000
    });
    expect(r.stdout.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });
});
