import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFieaServer } from "../src/server.js";

const ADDER = `#!/usr/bin/env node
const ns = process.argv.slice(2).map(Number);
if (ns.some(isNaN)) { console.error("not a number"); process.exit(1); }
console.log(ns.reduce((a, b) => a + b, 0));
`;

function makeAdder(): string {
  const dir = mkdtempSync(join(tmpdir(), "fea-"));
  const file = join(dir, "adder.js");
  writeFileSync(file, ADDER);
  chmodSync(file, 0o755);
  return file;
}

async function connectedClient(storeDir: string): Promise<Client> {
  const { server } = createFieaServer(storeDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fea-test", version: "0.1.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  if (res.isError) throw new Error(`tool ${name} failed: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0].text as string);
}

describe("FEA MCP server", () => {
  it("exposes 18 tools", async () => {
    const client = await connectedClient(mkdtempSync(join(tmpdir(), "fea-")));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "fea_ingest_target",
        "fea_capture_behavior",
        "fea_extract_spec",
        "fea_get_spec",
        "fea_plan_rebuild",
        "fea_synthesis_context",
        "fea_verify_parity",
        "fea_export_pack",
        "fea_doctor",
        "fea_read",
        "fea_approve",
        "fea_fuzz",
        "fea_report",
        "fea_verify_pack",
        "fea_diff_vectorsets",
        "fea_twin_publish",
        "fea_twin_search",
        "fea_twin_get"
      ].sort()
    );
    await client.close();
  });

  it("policy deny refuses the tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fea-"));
    const storeDir = join(dir, ".fea");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      join(storeDir, "fea.policy.json"),
      JSON.stringify({ version: "1.0", tools: { fea_read: "deny" } })
    );
    const client = await connectedClient(storeDir);
    const res = (await client.callTool({
      name: "fea_read",
      arguments: { targetId: "tgt_x", tool: "x" }
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("denied by policy");
    await client.close();
  });

  it("policy ask stages an approval instead of executing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fea-"));
    const storeDir = join(dir, ".fea");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      join(storeDir, "fea.policy.json"),
      JSON.stringify({ version: "1.0", tools: { fea_capture_behavior: "ask" } })
    );
    const client = await connectedClient(storeDir);
    const out = (await call(client, "fea_capture_behavior", {
      targetId: "tgt_x",
      plans: []
    })) as { approvalRequired: boolean; approvalToken: string };
    expect(out.approvalRequired).toBe(true);
    expect(out.approvalToken).toMatch(/^tappr_/);
    await client.close();
  });

  it("refuses ingest without authorization", async () => {
    const client = await connectedClient(mkdtempSync(join(tmpdir(), "fea-")));
    await expect(
      call(client, "fea_ingest_target", { pathOrUrl: "/tmp/x", kind: "cli", iHaveRights: false })
    ).rejects.toThrow(/authorization/);
    await client.close();
  });

  it("runs the full loop: ingest → capture → spec → plan → context → verify → pack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fea-"));
    const client = await connectedClient(join(dir, ".fea"));
    const adder = makeAdder();

    const target = (await call(client, "fea_ingest_target", {
      pathOrUrl: adder,
      kind: "cli",
      iHaveRights: true
    })) as { id: string };
    expect(target.id).toMatch(/^tgt_/);

    const cap = (await call(client, "fea_capture_behavior", {
      targetId: target.id,
      plans: [
        { name: "add", argv: ["2", "3"] },
        { name: "bad", argv: ["x"] }
      ]
    })) as { vectorSetId: string; count: number };
    expect(cap.count).toBe(2);

    const spec = (await call(client, "fea_extract_spec", {
      vectorSetId: cap.vectorSetId
    })) as { id: string; surfaces: unknown[] };
    expect(spec.surfaces.length).toBeGreaterThan(0);

    const plan = (await call(client, "fea_plan_rebuild", { specId: spec.id })) as {
      plan: string[];
      approvalToken: string;
      needsApproval: boolean;
    };
    expect(plan.needsApproval).toBe(true);

    // firewall: synthesis context must not leak forbidden keys
    const ctx = (await call(client, "fea_synthesis_context", {
      specId: spec.id,
      approvalToken: plan.approvalToken
    })) as { surfaces: Array<{ ioExamples: unknown[] }> };
    expect(JSON.stringify(ctx)).not.toMatch(/pseudocode|assembly|decompil/i);
    expect(ctx.surfaces[0].ioExamples.length).toBeGreaterThan(0);

    // token is single-use
    await expect(
      call(client, "fea_synthesis_context", { specId: spec.id, approvalToken: plan.approvalToken })
    ).rejects.toThrow(/consumed|invalid/);

    // verify: rebuild IS the original here → parity 100
    const { report, passed } = (await call(client, "fea_verify_parity", {
      originalTargetId: target.id,
      rebuildPath: adder,
      vectorSetId: cap.vectorSetId,
      failUnder: 100
    })) as { report: { id: string; score: number }; passed: boolean };
    expect(report.score).toBe(100);
    expect(passed).toBe(true);

    const pack = (await call(client, "fea_export_pack", {
      specId: spec.id,
      reportId: report.id
    })) as { packDir: string; manifestSha256: string };
    expect(pack.manifestSha256).toMatch(/^[0-9a-f]{64}$/);

    const doctor = (await call(client, "fea_doctor", {})) as { fea: string };
    expect(doctor.fea).toBe("1.0.0");

    await client.close();
  });
});
