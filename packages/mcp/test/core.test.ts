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
    expect(d.fea).toBe("1.1.0");
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

  it("twinPublish publishes a verified twin; twinSearch finds it", async () => {
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
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdtempSync } = await import("node:fs");
    const indexPath = join(mkdtempSync(join(tmpdir(), "fea-")), "index.json");

    const entry = core.twinPublish({
      packPath: packDir,
      name: "adder-twin",
      version: "1.0.0",
      description: "adder reimplementation",
      indexPath
    });
    expect(entry.name).toBe("adder-twin");
    expect(entry.parityScore).toBe(100);
    expect(entry.targetFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.packSha256).toMatch(/^[0-9a-f]{64}$/);

    const found = core.twinSearch({ query: "adder", indexPath });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("adder-twin");
    expect(core.twinSearch({ query: "no-such-thing", indexPath })).toHaveLength(0);
  });

  it("twinPublish refuses a tampered pack", async () => {
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
    const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const specPath = join(packDir, "spec.json");
    const tampered = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    tampered["version"] = "9.9-hacked";
    writeFileSync(specPath, JSON.stringify(tampered));
    expect(() =>
      core.twinPublish({
        packPath: packDir,
        name: "bad-twin",
        indexPath: join(mkdtempSync(join(tmpdir(), "fea-")), "index.json")
      })
    ).toThrow(/pack-verify failed/);
  });

  it("twinPublish refuses packs with extra files", async () => {
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
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    writeFileSync(join(packDir, "original-binary-smuggled"), "evil");
    expect(() =>
      core.twinPublish({
        packPath: packDir,
        name: "smuggle-twin",
        indexPath: join(mkdtempSync(join(tmpdir(), "fea-")), "index.json")
      })
    ).toThrow(/outside the manifest/);
  });

  it("twinGet fetches and re-verifies the pack", async () => {
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
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdtempSync } = await import("node:fs");
    const indexPath = join(mkdtempSync(join(tmpdir(), "fea-")), "index.json");
    core.twinPublish({ packPath: packDir, name: "adder-twin", indexPath });

    const outDir = join(mkdtempSync(join(tmpdir(), "fea-")), "fetched");
    const { entry, packDir: fetched } = await core.twinGet({
      name: "adder-twin",
      outDir,
      indexPath
    });
    expect(entry.name).toBe("adder-twin");
    expect(fetched).toBe(outDir);
    // the fetched pack verifies standalone
    expect(core.verifyPack({ packPath: fetched }).valid).toBe(true);
    await expect(core.twinGet({ name: "nope", indexPath })).rejects.toThrow(/unknown twin/);
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

  it("diffVectorSets finds added, removed, and changed vectors", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId: setA } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const { vectorSetId: setB } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }, { argv: ["4", "5"] }]
    });

    const d1 = core.diffVectorSets({ a: setA, b: setB });
    expect(d1.unchanged).toBe(1);
    expect(d1.added).toHaveLength(1);
    expect(d1.removed).toHaveLength(0);
    expect(d1.changed).toHaveLength(0);

    const d2 = core.diffVectorSets({ a: setB, b: setA });
    expect(d2.removed).toHaveLength(1);
    expect(d2.added).toHaveLength(0);

    // same input, different behavior → changed
    const variant = makeScript("#!/usr/bin/env node\nconsole.log('wrong');\n");
    const targetV = core.ingestTarget({ pathOrUrl: variant, kind: "cli", iHaveRights: true });
    const { vectorSetId: setC } = await core.captureBehavior({
      targetId: targetV.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const d3 = core.diffVectorSets({ a: setA, b: setC });
    expect(d3.unchanged).toBe(0);
    expect(d3.changed).toHaveLength(1);
    expect(d3.changed[0].changes).toContain("output.stdout");
  });

  it("diffVectorSets treats identical sets as fully unchanged", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }, { argv: ["4", "5"] }]
    });
    const d = core.diffVectorSets({ a: vectorSetId, b: vectorSetId });
    expect(d.unchanged).toBe(2);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(0);
  });

  it("evolve converges when the agent learns from failing vectors", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const spec = core.extractSpec({ vectorSetId });
    const dir = mkdtempSync(join(tmpdir(), "fea-evo-"));
    const agentPath = join(dir, "mock-agent.cjs");
    const reqPrefix = join(dir, "req-");
    const rebuildPrefix = join(dir, "rebuild-");
    writeFileSync(
      agentPath,
      "const fs = require('node:fs');\n" +
        `const GOOD = ${JSON.stringify(ADDER)};\n` +
        "let input = '';\n" +
        "process.stdin.on('data', (c) => (input += c));\n" +
        "process.stdin.on('end', () => {\n" +
        "  const req = JSON.parse(input);\n" +
        `  fs.writeFileSync(${JSON.stringify(reqPrefix)} + req.attempt + '.json', input);\n` +
        `  const rebuild = ${JSON.stringify(rebuildPrefix)} + req.attempt + '.js';\n` +
        "  const src = req.attempt === 1 ? '#!/usr/bin/env node\\nconsole.log(\\'broken\\');\\n' : GOOD;\n" +
        "  fs.writeFileSync(rebuild, src, { mode: 0o755 });\n" +
        "  console.log(JSON.stringify({ rebuildPath: rebuild }));\n" +
        "});\n"
    );
    const evo = await core.evolve({
      specId: spec.id,
      vectorSetId,
      agentCommand: "node",
      agentArgs: [agentPath],
      maxAttempts: 3
    });
    const { readFileSync } = await import("node:fs");
    expect(evo.converged).toBe(true);
    expect(evo.attempts).toHaveLength(2);
    expect(evo.bestScore).toBe(100);
    expect(evo.attempts[0].score).toBe(0);
    const req2 = JSON.parse(readFileSync(join(dir, "req-2.json"), "utf8")) as {
      failingVectors: unknown[];
      lastScore: number;
    };
    expect(req2.failingVectors.length).toBeGreaterThan(0);
    expect(req2.lastScore).toBe(0);
    const req1raw = readFileSync(join(dir, "req-1.json"), "utf8");
    expect(req1raw).not.toContain(adder);
    expect(JSON.parse(req1raw).synthesisContext.surfaces.length).toBeGreaterThan(0);
  });

  it("evolve gives up after maxAttempts without converging", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const spec = core.extractSpec({ vectorSetId });
    const dir = mkdtempSync(join(tmpdir(), "fea-evo-"));
    const agentPath = join(dir, "stubborn.cjs");
    const rebuildFile = join(dir, "r.js");
    writeFileSync(
      agentPath,
      "let input = '';\n" +
        "process.stdin.on('data', (c) => (input += c));\n" +
        "process.stdin.on('end', () => {\n" +
        `  require('node:fs').writeFileSync(${JSON.stringify(rebuildFile)}, '#!/usr/bin/env node\\nconsole.log(\\'nope\\');\\n', { mode: 0o755 });\n` +
        `  console.log(JSON.stringify({ rebuildPath: ${JSON.stringify(rebuildFile)} }));\n` +
        "});\n"
    );
    const evo = await core.evolve({
      specId: spec.id,
      vectorSetId,
      agentCommand: "node",
      agentArgs: [agentPath],
      maxAttempts: 3
    });
    expect(evo.converged).toBe(false);
    expect(evo.attempts).toHaveLength(3);
    expect(evo.bestScore).toBe(0);
  });

  it("evolve rejects an agent that breaks the JSON protocol", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const spec = core.extractSpec({ vectorSetId });
    const dir = mkdtempSync(join(tmpdir(), "fea-evo-"));
    const agentPath = join(dir, "garbage.cjs");
    writeFileSync(agentPath, "console.log('i am not json');\n");
    await expect(
      core.evolve({ specId: spec.id, vectorSetId, agentCommand: "node", agentArgs: [agentPath] })
    ).rejects.toThrow(/must print JSON/);
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

describe("v1.1 core: promote + agent presets", () => {
  it("promote stores a new vector set with the rebuild's outputs", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    // intentional behavior change: the rebuild doubles instead of adding
    const doubler = makeScript(
      "#!/usr/bin/env node\nconsole.log(2 * Number(process.argv[2]) + 2 * Number(process.argv[3]));\n"
    );
    const { report: before } = await core.verifyParity({
      originalTargetId: target.id,
      rebuildPath: doubler,
      vectorSetId
    });
    expect(before.score).toBe(0);

    const newSet = await core.promote({ targetId: target.id, vectorSetId, rebuildPath: doubler });
    expect(newSet.id).not.toBe(vectorSetId);
    expect(newSet.vectors).toHaveLength(1);
    // inputs replayed, outputs now the rebuild's (blessed) behavior
    expect(newSet.vectors[0].input).toMatchObject({ kind: "cli", argv: ["2", "3"] });
    expect(newSet.vectors[0].output).toMatchObject({ kind: "cli", stdout: "10\n" });
  });

  it("promote requires the right rebuild kind", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    await expect(core.promote({ targetId: target.id, vectorSetId })).rejects.toThrow(/rebuildPath/);
  });

  it("evolve accepts an agent preset (fake codex shim)", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const spec = core.extractSpec({ vectorSetId });

    // fake `codex` on PATH: ignores the prompt, prints the correct program
    const binDir = mkdtempSync(join(tmpdir(), "fea-fakebin-"));
    const shim = join(binDir, "codex");
    writeFileSync(
      shim,
      `#!/bin/sh\n# consume stdin (the prompt), print canned code\ncat > /dev/null\ncat ${JSON.stringify(join(binDir, "canned.js"))}\n`
    );
    writeFileSync(join(binDir, "canned.js"), ADDER);
    chmodSync(shim, 0o755);
    const oldPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      const evo = await core.evolve({
        specId: spec.id,
        vectorSetId,
        agentPreset: "codex",
        maxAttempts: 2,
        attemptTimeoutMs: 30_000
      });
      expect(evo.converged).toBe(true);
      expect(evo.bestScore).toBe(100);
      expect(evo.attempts).toHaveLength(1);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("evolve rejects unknown presets and preset+command combos", async () => {
    const core = await makeCore();
    const adder = makeScript(ADDER);
    const target = core.ingestTarget({ pathOrUrl: adder, kind: "cli", iHaveRights: true });
    const { vectorSetId } = await core.captureBehavior({
      targetId: target.id,
      plans: [{ argv: ["2", "3"] }]
    });
    const spec = core.extractSpec({ vectorSetId });
    await expect(
      core.evolve({ specId: spec.id, vectorSetId, agentPreset: "gpt-9", maxAttempts: 1 })
    ).rejects.toThrow(/unknown agent preset/);
    await expect(
      core.evolve({ specId: spec.id, vectorSetId, agentPreset: "codex", agentCommand: "node", maxAttempts: 1 })
    ).rejects.toThrow(/not both/);
    await expect(
      core.evolve({ specId: spec.id, vectorSetId, maxAttempts: 1 })
    ).rejects.toThrow(/agentCommand \(\+agentArgs\) or agentPreset/);
  });
});
