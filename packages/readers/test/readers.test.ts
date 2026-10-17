import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { captureCli, captureHttp, describeTarget } from "../src/index.js";

function makeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fea-"));
  const file = join(dir, "tool.js");
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  return file;
}

describe("describeTarget", () => {
  it("hashes a CLI binary into a descriptor", () => {
    const bin = makeScript("console.log('hi');");
    const t = describeTarget(bin, "cli");
    expect(t.id).toMatch(/^tgt_[0-9a-f]{8}$/);
    expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects missing files", () => {
    expect(() => describeTarget("/no/such/file", "cli")).toThrow();
  });
});

describe("captureCli", () => {
  it("records stdout and exit code per plan", async () => {
    const bin = makeScript(
      "const [a,b] = process.argv.slice(2).map(Number); console.log(a + b);"
    );
    const vectors = await captureCli(process.execPath, [
      { name: "add", argv: [bin, "2", "3"] }
    ]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0].output).toMatchObject({
      kind: "cli",
      stdout: "5\n",
      exitCode: 0
    });
  });
});

describe("captureHttp", () => {
  it("records status and body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const vectors = await captureHttp([
        { name: "health", method: "GET", url: `http://127.0.0.1:${port}/health` }
      ]);
      expect(vectors[0].output).toMatchObject({ kind: "http", status: 200 });
      if (vectors[0].output.kind === "http") {
        expect(vectors[0].output.body).toContain('"ok":true');
      }
    } finally {
      server.close();
    }
  });
});
