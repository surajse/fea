import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ReaReader, type ReaReaderOptions } from "./reaReader.js";

export interface ReaderProxyOptions {
  /** default 3210 */
  port?: number;
  /** default: random, printed once at startup */
  token?: string;
  /** how the proxy reaches REA (default: `rea mcp` stdio) */
  reader?: ReaReaderOptions;
}

export interface ReaderProxy {
  url: string;
  token: string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Hold ONE reader session and share it over loopback HTTP. This is what
 * makes document-stateful REA workflows (open_binary -> list_strings)
 * work across separate `fea read` calls: every call hits the same
 * session. Binds 127.0.0.1 only; bearer token required except /health.
 */
export async function serveReaderProxy(opts: ReaderProxyOptions = {}): Promise<ReaderProxy> {
  const reader = await ReaReader.connect(opts.reader ?? {});
  const token = opts.token ?? randomUUID().replace(/-/g, "");
  const port = opts.port ?? 3210;

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        const tools = await reader.listTools().catch(() => []);
        json(res, 200, { ok: true, reader: "rea", tools: tools.length });
        return;
      }
      if (!authorized(req, token)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/tools") {
        const tools = await reader.listTools();
        json(res, 200, {
          tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" }))
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/call") {
        const body = JSON.parse(await readBody(req)) as { tool?: string; args?: Record<string, unknown> };
        if (typeof body.tool !== "string") {
          json(res, 400, { error: "missing 'tool'" });
          return;
        }
        try {
          const result = await reader.callTool(body.tool, body.args ?? {});
          json(res, 200, { result });
        } catch (e) {
          json(res, 200, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const bound = server.address();
  const actualPort = typeof bound === "object" && bound !== null ? bound.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    token,
    close: async () => {
      await reader.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
