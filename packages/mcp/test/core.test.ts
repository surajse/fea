import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FeaCore } from "../src/core.js";
import { FeaStore } from "../src/store.js";

const ADDER = `#!/usr/bin/env node
const ns = process.argv.slice(2).map(Number);
if (ns.some(isNaN)) { console.error("not a number"); process.exit(1); }
console.log(ns.reduce((a, b) => a + b, 0));
`;

function makeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fea-"));
  const file = join(dir, "tool.js");
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

/** Stub REA server: one fake analysis tool. */
function stubReaServer(): McpServer {
  const server = new McpServer({ name: "rea-stub", version: "0.0.0" });
  server.tool(
    "rea_fake_open",
    "Fake: open a binary",
    { path: z.string() },
    async ({ path }) => ({
      content: [{ type: "text", text: `opened ${path} as doc-1` }]
    })
  );
  server.tool(
    "rea_fake_exports",
    "Fake: list exports of a binary",
    { path: z.string() },
    async ({ path }) => ({
      content: [{ type: "text", text: `exports of ${path}: main, helper_add` }]
    })
  );
  return server;
}

async function makeCore(): Promise<FeaCore> {
  const dir = mkdtempSync(join(tmpdir(), "fea-"));
  const server = stubReaServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return new FeaCore(new FeaStore(join(dir, ".fea")), { readerTransport: clientTransport });
}

describe("v0.2 core: native kind + reader notes + failUnder", () => {
  it("ingests a native binary and captures it like a CLI", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "native", iHaveRights: true });
    expect(target.kind).toBe("native");
    const { count } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ name: "add", argv: ["2", "3"] }]
    });
    expect(count).toBe(1);
  });

  it("readWithReader stores findings as evidence notes", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "native", iHaveRights: true });
    const notes = await core.readWithReader({
      targetId: target.id,
      tool: "rea_fake_exports",
      args: { path: adder }
    });
    expect(notes.reader).toBe("rea");
    expect(notes.summary).toContain("helper_add");
    expect(notes.truncated).toBe(false);
  });

  it("runs prelude calls in the same reader session", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "native", iHaveRights: true });
    const notes = await core.readWithReader({
      targetId: target.id,
      tool: "rea_fake_exports",
      args: {},
      prelude: [{ tool: "rea_fake_open", args: { path: adder } }]
    });
    expect(notes.prelude).toHaveLength(1);
    expect(notes.prelude?.[0].tool).toBe("rea_fake_open");
    expect(notes.prelude?.[0].summary).toContain("doc-1");
  });

  it("extractSpec attaches reader notes as evidence", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "native", iHaveRights: true });
    const notes = await core.readWithReader({
      targetId: target.id,
      tool: "rea_fake_exports",
      args: {}
    });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["1", "2"] }]
    });
    const spec = core.extractSpec({ vectorSetId, notesId: notes.id });
    const readerEvidence = spec.evidence.filter((e) => e.kind === "reader-note");
    expect(readerEvidence.length).toBeGreaterThan(0);
    expect(readerEvidence[0].ref).toContain(notes.id);
  });

  it("rejects notes from a different target", async () => {
    const core = await makeCore();
    const a = makeScript(ADDER);
    const b = makeScript(ADDER + "\n// different build\n");
    const t1 = core.ingestTarget({ pathOrUrl: a, kind: "cli", iHaveRights: true });
    const t2 = core.ingestTarget({ pathOrUrl: b, kind: "cli", iHaveRights: true });
    expect(t1.id).not.toBe(t2.id);
    const notes = await core.readWithReader({ targetId: t1.id, tool: "rea_fake_exports", args: {} });
    const { vectorSetId } = await core.captureBehavior({
      targetId: t2.id,
      plans: [{ argv: ["1"] }]
    });
    expect(() => core.extractSpec({ vectorSetId, notesId: notes.id })).toThrow(/different target/);
  });

  it("verifyParity failUnder: passes at 100, fails below", async () => {
    const core = await makeCore();
    const good = makeScript(ADDER);
    const buggy = makeScript(ADDER.replace("a + b", "a + b + 1"));
    const target = core.ingestTarget({ pathOrUrl: good, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });

    const ok = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: good,
      vectorSetId,
      failUnder: 100
    });
    expect(ok.report.score).toBe(100);
    expect(ok.passed).toBe(true);

    const bad = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: buggy,
      vectorSetId,
      failUnder: 100
    });
    expect(bad.report.score).toBeLessThan(100);
    expect(bad.passed).toBe(false);
  });

  it("doctor reports sandbox backend and REA status", async () => {
    const core = await makeCore();
    const d = await core.doctor();
    expect(d.fea).toBe("0.7.0");
    expect(d.sandboxBackend).toBe("spawn");
    // reaInstalled depends on the machine (real REA may be installed) —
    // assert shape, not value.
    expect(typeof d.reaInstalled).toBe("boolean");
    expect(typeof d.dockerAvailable).toBe("boolean");
  });

  it("policy ask flow: stage then approve executes the call", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const req = await core.requestToolApproval("fea_capture_behavior", {
      targetId: target.id,
      plans: [{ name: "add", argv: ["2", "3"] }]
    });
    expect(req.approvalRequired).toBe(true);
    expect(req.approvalToken).toMatch(/^tappr_/);
    expect(req.summary).toContain("1 capture plan");

    const result = (await core.approveTool({ approvalToken: req.approvalToken })) as {
      vectorSetId: string;
      count: number;
    };
    expect(result.count).toBe(1);

    // token is single-use
    await expect(core.approveTool({ approvalToken: req.approvalToken })).rejects.toThrow(
      /invalid or already consumed/
    );
  });

  it("approveTool rejects unknown tokens", async () => {
    const core = await makeCore();
    await expect(core.approveTool({ approvalToken: "tappr_nope" })).rejects.toThrow();
  });

  it("fuzzVectors stores recorded + generated vectors", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const spec = core.extractSpec({ vectorSetId });
    const { vectorSetId: fuzzId, generated } = core.fuzzVectors({
      specId: spec.id,
      count: 10,
      seed: "test-seed"
    });
    expect(generated).toBe(10);
    expect(fuzzId).toMatch(/^vs_fuzz_/);
  });

  it("verifyPack validates a genuine pack", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const spec = core.extractSpec({ vectorSetId });
    const { report } = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: adder,
      vectorSetId
    });
    const { packDir } = core.exportPack({ specId: spec.id, reportId: report.id });
    const res = core.verifyPack({ packPath: packDir });
    expect(res.valid).toBe(true);
    expect(res.checks.length).toBeGreaterThan(5);
    expect(res.checks.every((c) => c.ok)).toBe(true);
  });

  it("verifyPack catches a tampered spec", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const spec = core.extractSpec({ vectorSetId });
    const { report } = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: adder,
      vectorSetId
    });
    const { packDir } = core.exportPack({ specId: spec.id, reportId: report.id });
    // tamper with the spec file inside the pack
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const specPath = join(packDir, "spec.json");
    const tampered = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    tampered["version"] = "9.9-hacked";
    writeFileSync(specPath, JSON.stringify(tampered));
    const res = core.verifyPack({ packPath: packDir });
    expect(res.valid).toBe(false);
    expect(res.checks.some((c) => !c.ok && c.name.includes("spec.json"))).toBe(true);
  });

  it("verifyPack rejects a missing manifest", async () => {
    const core = await makeCore();
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const res = core.verifyPack({ packPath: join(mkdtempSync(join(tmpdir(), "fea-")), "nope") });
    expect(res.valid).toBe(false);
    expect(res.checks[0].name).toBe("manifest parses");
  });

  it("pinBaseline stores a baseline; verifyParity reports the delta", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const { report } = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: adder,
      vectorSetId
    });
    const baseline = core.pinBaseline({ targetId: target.id, vectorSetId, reportId: report.id });
    expect(baseline.score).toBe(100);

    // a worse rebuild now shows a negative delta
    const bad = makeScript("#!/usr/bin/env node\nconsole.log('wrong');\n");
    const res2 = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: bad,
      vectorSetId
    });
    expect(res2.baseline?.score).toBe(100);
    expect(res2.baseline?.delta).toBeLessThan(0);
  });

  it("watchParity re-runs when the rebuild file changes", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const rebuild = makeScript(ADDER);
    const events: Array<{ run: number; score: number; fingerprint: string }> = [];

    // change the rebuild after the first run
    let changed = false;
    const { writeFileSync } = await import("node:fs");
    const { runs } = await core.watchParity(
      { targetId: target.id, rebuildPath: rebuild, vectorSetId, pollMs: 30, maxRuns: 2 },
      (e) => {
        events.push({ run: e.run, score: e.report.score, fingerprint: e.fingerprint });
        if (!changed) {
          changed = true;
          writeFileSync(rebuild, "#!/usr/bin/env node\nconsole.log('changed');\n");
        }
      }
    );
    expect(runs).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0].score).toBe(100);
    expect(events[1].score).toBeLessThan(100);
    expect(events[0].fingerprint).not.toBe(events[1].fingerprint);
  });

  it("reportJunit writes exact per-vector testcases", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }, { argv: ["bad-input"] }]
    });
    // make the second vector fail with a broken rebuild
    const bad = makeScript("#!/usr/bin/env node\nconsole.log('nope');\n");
    const { report } = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: bad,
      vectorSetId
    });
    const { path } = core.reportJunit({ reportId: report.id });
    const { readFileSync } = await import("node:fs");
    const xml = readFileSync(path, "utf8");
    expect(xml).toContain(`tests="${report.total}"`);
    expect(xml).toContain(`failures="${report.failed}"`);
    expect(xml).toContain("<failure");
    expect(xml).toContain("parity score");
  });

  it("reportHtml renders a self-contained report with escaping", async () => {
    const core = await makeCore();
    const good = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: good, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const { report } = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: good,
      vectorSetId
    });
    const { path } = core.reportHtml({ reportId: report.id });
    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, "utf8");
    expect(html).toContain(String(report.score));
    expect(html).toContain("not a formal proof");
    // no external assets
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });
});
