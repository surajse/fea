import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ReaReader, serveReaderProxy } from "../src/index.js";

/** Stub REA server with SESSION STATE: open must precede data. */
function stubSessionServer(): { server: McpServer; state: { opened: boolean } } {
  const state = { opened: false };
  const server = new McpServer({ name: "rea-stub", version: "0.0.0" });
  server.tool("sess_open", "Fake: open a document", { path: z.string() }, async () => {
    state.opened = true;
    return { content: [{ type: "text", text: "opened doc-1" }] };
  });
  server.tool("sess_data", "Fake: needs an open document", {}, async () => {
    return {
      content: [{ type: "text", text: state.opened ? "session:doc-1" : "no-session" }]
    };
  });
  return { server, state };
}

describe("serveReaderProxy", () => {
  it("shares one persistent session over loopback HTTP", async () => {
    const { server } = stubSessionServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const proxy = await serveReaderProxy({ port: 0, token: "test-token", reader: { transport: clientT } });

    const remote = await ReaReader.connectRemote(proxy.url, "test-token");
    // two SEPARATE remote calls, one session: open then data
    await remote.callTool("sess_open", { path: "/x" });
    const data = await remote.callTool("sess_data", {});
    expect(JSON.stringify(data)).toContain("session:doc-1");
    await remote.close();
    await proxy.close();
  });

  it("lists tools through the proxy", async () => {
    const { server } = stubSessionServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const proxy = await serveReaderProxy({ port: 0, token: "t2", reader: { transport: clientT } });
    const remote = await ReaReader.connectRemote(proxy.url, "t2");
    const tools = await remote.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["sess_data", "sess_open"]);
    await remote.close();
    await proxy.close();
  });

  it("rejects wrong tokens on protected endpoints", async () => {
    const { server } = stubSessionServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const proxy = await serveReaderProxy({ port: 0, token: "right", reader: { transport: clientT } });
    // /health is auth-free by design, so connect succeeds; /tools requires the token
    const remote = await ReaReader.connectRemote(proxy.url, "wrong");
    await expect(remote.listTools()).rejects.toThrow(/401/);
    await remote.close();
    await proxy.close();
  });

  it("relays MCP isError results as data, like the direct path", async () => {
    const { server } = stubSessionServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const proxy = await serveReaderProxy({ port: 0, token: "t3", reader: { transport: clientT } });
    const remote = await ReaReader.connectRemote(proxy.url, "t3");
    const res = (await remote.callTool("no_such_tool", {})) as { isError?: boolean };
    expect(res.isError).toBe(true);
    await remote.close();
    await proxy.close();
  });
});
