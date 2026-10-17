import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { Vector } from "@fea/spec";
import { runParity, swapOrigin } from "../src/runner.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function jsonHandler(body: unknown, status = 200): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", "x-app": "test" });
    res.end(JSON.stringify(body));
  };
}

function httpVector(url: string, id = "vec_1"): Vector {
  return {
    id,
    weight: 2,
    input: { kind: "http", method: "GET", url },
    output: { kind: "http", status: 200, headers: {}, body: "" },
    recordedAt: new Date().toISOString()
  };
}

describe("swapOrigin", () => {
  it("swaps the origin, keeps path+query", () => {
    expect(swapOrigin("http://a:3000/users?page=2", "http://b:4000")).toBe(
      "http://b:4000/users?page=2"
    );
  });

  it("resolves relative URLs against the base", () => {
    expect(swapOrigin("/users", "http://b:4000/api")).toBe("http://b:4000/users");
  });
});

describe("runParity with HTTP vectors", () => {
  it("scores 100 for identical APIs", async () => {
    const a = await startServer(jsonHandler({ msg: "hi" }));
    const b = await startServer(jsonHandler({ msg: "hi" }));
    try {
      const report = await runParity({
        original: a.url,
        rebuildUrl: b.url,
        vectors: [httpVector(`${a.url}/hello`)],
        packs: ["http"]
      });
      expect(report.score).toBe(100);
      expect(report.passed).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("reports a failing vector on body mismatch", async () => {
    const a = await startServer(jsonHandler({ msg: "hi" }));
    const b = await startServer(jsonHandler({ msg: "bye" }));
    try {
      const report = await runParity({
        original: a.url,
        rebuildUrl: b.url,
        vectors: [httpVector(`${a.url}/hello`)],
        packs: ["http"]
      });
      expect(report.score).toBe(0);
      expect(report.failingVectors.some((f) => f.field === "body")).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("reports a failing vector on status mismatch", async () => {
    const a = await startServer(jsonHandler({ msg: "hi" }, 200));
    const b = await startServer(jsonHandler({ msg: "hi" }, 500));
    try {
      const report = await runParity({
        original: a.url,
        rebuildUrl: b.url,
        vectors: [httpVector(`${a.url}/hello`)],
        packs: ["http"]
      });
      expect(report.failingVectors.some((f) => f.field === "status")).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("replays POST bodies", async () => {
    const echo: Handler = (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "x-app": "test" });
        res.end(JSON.stringify({ echo: body }));
      });
    };
    const a = await startServer(echo);
    const b = await startServer(echo);
    try {
      const vector: Vector = {
        id: "vec_post",
        weight: 2,
        input: { kind: "http", method: "POST", url: `${a.url}/echo`, body: '{"a":1}' },
        output: { kind: "http", status: 200, headers: {}, body: "" },
        recordedAt: new Date().toISOString()
      };
      const report = await runParity({
        original: a.url,
        rebuildUrl: b.url,
        vectors: [vector],
        packs: ["http"]
      });
      expect(report.score).toBe(100);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("throws a clear error when rebuildUrl is missing", async () => {
    const a = await startServer(jsonHandler({ msg: "hi" }));
    try {
      await expect(
        runParity({ original: a.url, vectors: [httpVector(`${a.url}/x`)] })
      ).rejects.toThrow(/rebuildUrl/);
    } finally {
      await a.close();
    }
  });

  it("throws a clear error when rebuild is missing for CLI vectors", async () => {
    const vector: Vector = {
      id: "vec_cli",
      weight: 2,
      input: { kind: "cli", argv: ["x"] },
      output: { kind: "cli", stdout: "", stderr: "", exitCode: 0 },
      recordedAt: new Date().toISOString()
    };
    await expect(
      runParity({ original: "/bin/echo", rebuildUrl: "http://x", vectors: [vector] })
    ).rejects.toThrow(/rebuild/);
  });
});
