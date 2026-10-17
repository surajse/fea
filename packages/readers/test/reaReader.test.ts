import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReaReader, capFindings, probeRea, summarizeFindings } from "../src/reaReader.js";

/** A tiny stand-in for a REA MCP server. */
function stubReaServer(): McpServer {
  const server = new McpServer({ name: "rea-stub", version: "0.0.0" });
  server.tool("rea_list_exports", "List exported symbols of a binary", { path: z.string() }, async () => ({
    content: [{ type: "text", text: "exports: main, helper_add" }]
  }));
  server.tool("rea_ping", "Health check", {}, async () => ({
    content: [{ type: "text", text: "pong" }]
  }));
  return server;
}

async function connectedReader(): Promise<{ reader: ReaReader; server: McpServer }> {
  const server = stubReaServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const reader = await ReaReader.connect({ transport: clientTransport });
  return { reader, server };
}

describe("ReaReader", () => {
  it("lists the reader's tools", async () => {
    const { reader } = await connectedReader();
    const tools = await reader.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["rea_list_exports", "rea_ping"]);
    await reader.close();
  });

  it("calls a reader tool and returns its result", async () => {
    const { reader } = await connectedReader();
    const res = (await reader.callTool("rea_list_exports", { path: "/tmp/x" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(res.content[0].text).toContain("helper_add");
    await reader.close();
  });
});

describe("probeRea", () => {
  it("reports not-installed for a bogus command", async () => {
    const probe = await probeRea("fea-definitely-not-a-real-binary-xyz");
    expect(probe.installed).toBe(false);
  });
});

describe("summarizeFindings / capFindings", () => {
  it("summarizes text content", () => {
    const s = summarizeFindings({ content: [{ type: "text", text: "hello findings" }] });
    expect(s).toContain("hello findings");
  });

  it("caps oversized findings", () => {
    const big = { content: [{ type: "text", text: "x".repeat(300_000) }] };
    const { truncated } = capFindings(big);
    expect(truncated).toBe(true);
    const { truncated: t2 } = capFindings({ small: 1 });
    expect(t2).toBe(false);
  });
});
