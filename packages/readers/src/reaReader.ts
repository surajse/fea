import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SpawnBackend } from "@fea/sandbox";

export interface ReaReaderOptions {
  /** stdio command, default ["rea", "mcp"] */
  command?: string[];
  /** Streamable-HTTP endpoint alternative */
  url?: string;
  /** injected transport (tests) */
  transport?: Transport;
}

export interface ReaderToolInfo {
  name: string;
  description?: string;
}

/**
 * ReaReader — FEA's adapter for REA ("Reverse Engineer Anything").
 * FEA does not reimplement analysis: it connects to a running REA MCP
 * server (default: `rea mcp` over stdio) and calls its tools. Findings
 * stay on the analysis side as evidence; only distilled behavioral notes
 * (via fea_read) ever reach a spec, and never the synthesis context
 * except as behavior.
 */
export class ReaReader {
  private constructor(
    private lister: () => Promise<ReaderToolInfo[]>,
    private caller: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    private closer: () => Promise<void>
  ) {}

  static async connect(opts: ReaReaderOptions = {}): Promise<ReaReader> {
    let transport: Transport;
    if (opts.transport) {
      transport = opts.transport;
    } else if (opts.url) {
      transport = new StreamableHTTPClientTransport(new URL(opts.url));
    } else {
      const [command, ...args] = opts.command ?? ["rea", "mcp"];
      transport = new StdioClientTransport({ command, args });
    }
    const client = new Client({ name: "fea-rea-reader", version: "1.0.0" });
    await client.connect(transport);
    return new ReaReader(
      async () => {
        const res = await client.listTools();
        return res.tools.map((t) => ({ name: t.name, description: t.description }));
      },
      (name, args) => client.callTool({ name, arguments: args }),
      () => client.close()
    );
  }

  /**
   * Connect to a `fea reader serve` proxy (loopback HTTP). The proxy holds
   * ONE persistent REA session, so document-stateful workflows work across
   * separate fea_read calls.
   */
  static async connectRemote(url: string, token?: string): Promise<ReaReader> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const base = url.replace(/\/$/, "");
    const get = async <T>(path: string): Promise<T> => {
      const res = await fetch(base + path, { headers });
      if (!res.ok) throw new Error(`reader proxy ${path}: HTTP ${res.status}`);
      return (await res.json()) as T;
    };
    // fail fast if the proxy is unreachable or the token is wrong
    await get<{ ok: boolean }>("/health");
    return new ReaReader(
      async () => {
        const { tools } = await get<{ tools: ReaderToolInfo[] }>("/tools");
        return tools;
      },
      async (name, args) => {
        const res = await fetch(base + "/call", {
          method: "POST",
          headers,
          body: JSON.stringify({ tool: name, args })
        });
        if (!res.ok) throw new Error(`reader proxy /call: HTTP ${res.status}`);
        const data = (await res.json()) as { result?: unknown; error?: string };
        if (data.error) throw new Error(`reader tool "${name}": ${data.error}`);
        return data.result;
      },
      async () => {}
    );
  }

  async listTools(): Promise<ReaderToolInfo[]> {
    return this.lister();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.caller(name, args);
  }

  /**
   * Run several tool calls in the SAME connected session, in order.
   * Needed for document-stateful readers (e.g. REA: open_binary first,
   * then list_strings) — v0.2 spawns one reader process per fea_read call,
   * so the prelude keeps the whole workflow inside a single session.
   */
  async callSequence(calls: Array<{ tool: string; args?: Record<string, unknown> }>): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const c of calls) {
      results.push(await this.callTool(c.tool, c.args ?? {}));
    }
    return results;
  }

  async close(): Promise<void> {
    await this.closer();
  }
}

/**
 * Is a `rea` CLI available? Probed via the spawn backend directly so the
 * check never recurses when FEA_SANDBOX=docker.
 */
export async function probeRea(command = "rea"): Promise<{ installed: boolean; version?: string }> {
  try {
    const r = await new SpawnBackend().run(command, ["--version"], { timeoutMs: 10000 });
    const firstLine = r.stdout.trim().split("\n")[0] ?? "";
    if (r.exitCode === 0 && firstLine.length > 0) {
      return { installed: true, version: firstLine };
    }
    return { installed: false };
  } catch {
    return { installed: false };
  }
}

export interface ReaderNotes {
  id: string;
  targetId: string;
  reader: "rea";
  tool: string;
  args: Record<string, unknown>;
  /** summaries of prelude calls, in order (same session) */
  prelude?: Array<{ tool: string; summary: string }>;
  /** short human-readable summary of the findings */
  summary: string;
  /** raw tool result, size-capped */
  findings: unknown;
  truncated: boolean;
  createdAt: string;
}

const MAX_FINDINGS_CHARS = 200_000;

/** Extract a short summary from an MCP tool result. */
export function summarizeFindings(result: unknown): string {
  if (result !== null && typeof result === "object" && "content" in result) {
    const content = (result as { content: unknown }).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (c): c is { type: string; text: string } =>
            typeof c === "object" && c !== null && (c as { type: unknown }).type === "text"
        )
        .map((c) => c.text);
      if (texts.length > 0) return texts.join("\n").slice(0, 500);
    }
  }
  return JSON.stringify(result)?.slice(0, 500) ?? "(no findings)";
}

/** Cap raw findings for storage; report whether truncation happened. */
export function capFindings(result: unknown): { findings: unknown; truncated: boolean } {
  const raw = JSON.stringify(result) ?? "null";
  if (raw.length <= MAX_FINDINGS_CHARS) return { findings: result, truncated: false };
  return { findings: raw.slice(0, MAX_FINDINGS_CHARS), truncated: true };
}
