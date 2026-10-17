#!/usr/bin/env node
import { join } from "node:path";
import { Command } from "commander";
import { PolicyEngine } from "@fea/policy";
import { FeaCore, FeaStore, runStdio } from "@fea/mcp";

function coreFor(opts: { store?: string }): FeaCore {
  const dir = opts.store ?? join(process.cwd(), ".fea");
  return new FeaCore(new FeaStore(dir));
}

function print(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}

interface GlobalOpts {
  store: string;
  policy?: string;
}

function globals(cmd: Command): GlobalOpts {
  return (cmd.optsWithGlobals?.() ?? {}) as GlobalOpts;
}

/**
 * Policy gate for execution-class CLI commands. "deny" exits 1; "ask"
 * without --yes stages an approval and exits 2 with the token.
 */
async function gatedCli<T>(
  toolName: string,
  args: Record<string, unknown>,
  g: GlobalOpts,
  opts: { yes?: boolean },
  fn: () => Promise<T>
): Promise<T> {
  const policy = PolicyEngine.loadFor(g.store, g.policy);
  const decision = policy.check(toolName);
  if (decision === "deny") {
    console.error(`tool "${toolName}" is denied by policy (${policy.source})`);
    process.exit(1);
  }
  if (decision === "ask" && !opts.yes) {
    const req = await coreFor({ store: g.store }).requestToolApproval(toolName, args);
    print({ ...req, hint: `fea approve --token ${req.approvalToken} --store ${g.store}` });
    console.error(`approval required (policy: ${policy.source}); re-run with --yes to pre-approve`);
    process.exit(2);
  }
  return fn();
}

/** Workflow cheat-sheet written by `fea init`. */
function initDoc(name: string, kind: string): string {
  return `# ${name} — FEA project

Target kind: \`${kind}\`. The loop, in order:

\`\`\`bash
# 1. ingest (already done if you passed --target)
fea ingest <path-or-url> --kind ${kind} --i-have-rights --store .fea

# 2. capture black-box behavior (edit capture-plans.json first)
fea capture --target <target-id> --plans "$(cat capture-plans.json)" --store .fea

# 3. extract the behavioral spec
fea spec --vectorset <vectorset-id> --store .fea

# 4. plan the rebuild (human approval required)
fea plan --spec <spec-id> --store .fea
# ... review the plan, then approve:
fea synth-context --approval <token> --store .fea > context.json
# ... rebuild the target from context.json (clean-room: behavior only) ...

# 5. verify differential parity (http-api: use --rebuild-url)
fea verify --target <target-id> --rebuild <path> --vectorset <vectorset-id> --store .fea
fea verify --target <target-id> --rebuild-url http://127.0.0.1:3001 --vectorset <vs> --store .fea

# 6. report + evidence pack
fea report --report <report-id> --store .fea
fea pack --spec <spec-id> --report <report-id> --store .fea
\`\`\`

Policy: \`fea.policy.json\` (allow/ask/deny per tool). Execution-class tools
ask by default — approve with \`fea approve --token <t>\` or pass \`--yes\`.
`;
}

const program = new Command();
program
  .name("fea")
  .description("Forward Engineer Anything — verified reimplementation loop")
  .version("1.0.0")
  .option("--store <dir>", "FEA store directory", join(process.cwd(), ".fea"))
  .option("--policy <file>", "policy file (allow/ask/deny per tool)");

program
  .command("ingest")
  .description("Register a target you are authorized to analyze")
  .argument("<pathOrUrl>", "absolute path to a CLI/native binary, or base URL of an HTTP API")
  .option("--kind <kind>", "cli | http-api | native | apk", "cli")
  .option("--i-have-rights", "confirm you own / are licensed to analyze this target")
  .action((pathOrUrl: string, opts: { kind: string; iHaveRights?: boolean }, cmd) => {
    const g = globals(cmd);
    if (opts.kind !== "cli" && opts.kind !== "http-api" && opts.kind !== "native" && opts.kind !== "apk") {
      console.error("--kind must be cli, http-api, native or apk");
      process.exit(1);
    }
    print(coreFor({ store: g.store }).ingestTarget({
      pathOrUrl,
      kind: opts.kind as "cli" | "http-api" | "native" | "apk",
      iHaveRights: opts.iHaveRights === true
    }));
  });

program
  .command("read")
  .description("Ask the REA reader for analysis findings about a target (stored as evidence)")
  .requiredOption("--target <id>", "target id from ingest")
  .requiredOption("--tool <name>", "reader tool name (a REA MCP tool)")
  .option("--args <json>", "JSON arguments for the reader tool", "{}")
  .option("--prelude <json>", "JSON array of {tool, args} to run first in the same session")
  .option("--reader-cmd <cmd>", "custom reader stdio command, e.g. 'rea mcp'")
  .option("--proxy-url <url>", "`fea reader serve` proxy URL (persistent session)")
  .option("--proxy-token <t>", "bearer token for the reader proxy")
  .option("--yes", "pre-approve if policy says 'ask'")
  .action(
    async (
      opts: {
        target: string;
        tool: string;
        args: string;
        prelude?: string;
        readerCmd?: string;
        proxyUrl?: string;
        proxyToken?: string;
        yes?: boolean;
      },
      cmd
    ) => {
      const g = globals(cmd);
      const args = JSON.parse(opts.args) as Record<string, unknown>;
      const prelude = opts.prelude
        ? (JSON.parse(opts.prelude) as Array<{ tool: string; args?: Record<string, unknown> }>)
        : undefined;
      print(
        await gatedCli(
          "fea_read",
          { targetId: opts.target, tool: opts.tool, args, prelude },
          g,
          { yes: opts.yes },
          () =>
            coreFor({ store: g.store }).readWithReader({
              targetId: opts.target,
              tool: opts.tool,
              args,
              prelude,
              readerCommand: opts.readerCmd ? opts.readerCmd.split(" ") : undefined,
              readerProxyUrl: opts.proxyUrl,
              readerToken: opts.proxyToken
            })
        )
      );
    }
  );

const readerCmd = program.command("reader").description("Persistent REA reader sessions");

readerCmd
  .command("serve")
  .description("Hold one REA session and share it over loopback HTTP (127.0.0.1 only)")
  .option("--port <n>", "port to bind", "3210")
  .option("--reader-cmd <cmd>", "custom reader stdio command, e.g. 'rea mcp'")
  .option("--token <t>", "bearer token (default: random, printed once)")
  .action(async (opts: { port: string; readerCmd?: string; token?: string }) => {
    const { serveReaderProxy } = await import("@fea/readers");
    const proxy = await serveReaderProxy({
      port: parseInt(opts.port, 10),
      token: opts.token,
      reader: { command: opts.readerCmd ? opts.readerCmd.split(" ") : undefined }
    });
    console.log(`reader proxy: ${proxy.url}`);
    console.log(`token: ${proxy.token}`);
    console.log("press Ctrl-C to stop");
    await new Promise(() => {});
  });

program
  .command("capture")
  .description("Black-box capture: run the target with each plan, record I/O vectors")
  .requiredOption("--target <id>", "target id from ingest")
  .requiredOption("--plans <json>", 'JSON array, e.g. \'[{"name":"add","argv":["2","3"]}]\'')
  .option("--yes", "pre-approve if policy says 'ask'")
  .action(async (opts: { target: string; plans: string; yes?: boolean }, cmd) => {
    const g = globals(cmd);
    const plans = JSON.parse(opts.plans) as Array<Record<string, unknown>>;
    print(
      await gatedCli(
        "fea_capture_behavior",
        { targetId: opts.target, plans },
        g,
        { yes: opts.yes },
        () => coreFor({ store: g.store }).captureBehavior({ targetId: opts.target, plans })
      )
    );
  });

program
  .command("approve")
  .description("Approve a policy-gated tool call staged by an 'ask' decision")
  .requiredOption("--token <token>", "approval token from the staged request")
  .action(async (opts: { token: string }, cmd) => {
    const g = globals(cmd);
    print(await coreFor({ store: g.store }).approveTool({ approvalToken: opts.token }));
  });

program
  .command("spec")
  .description("Build a validated BehaviorSpec from a captured vector set")
  .requiredOption("--vectorset <id>", "vector set id from capture")
  .option("--notes <id>", "reader notes id to attach as evidence")
  .action((opts: { vectorset: string; notes?: string }, cmd) => {
    const g = globals(cmd);
    print(
      coreFor({ store: g.store }).extractSpec({
        vectorSetId: opts.vectorset,
        notesId: opts.notes
      })
    );
  });

program
  .command("plan")
  .description("Propose a rebuild plan (returns a one-time approval token)")
  .requiredOption("--spec <id>", "spec id")
  .action((opts: { spec: string }, cmd) => {
    const g = globals(cmd);
    print(coreFor({ store: g.store }).planRebuild({ specId: opts.spec }));
  });

program
  .command("synth-context")
  .description("Get the FIREWALLED synthesis context (behavior only)")
  .requiredOption("--spec <id>", "spec id")
  .requiredOption("--token <token>", "approval token from plan")
  .action((opts: { spec: string; token: string }, cmd) => {
    const g = globals(cmd);
    print(
      coreFor({ store: g.store }).synthesisContext({
        specId: opts.spec,
        approvalToken: opts.token
      })
    );
  });

program
  .command("verify")
  .description("Differential parity: original vs rebuild on the same vectors")
  .requiredOption("--target <id>", "original target id")
  .option("--rebuild <path>", "absolute path to the rebuilt binary (cli/native)")
  .option("--rebuild-url <url>", "base URL of the rebuilt API (http-api)")
  .requiredOption("--vectorset <id>", "vector set id")
  .option("--fail-under <n>", "CI mode: exit 1 when score is below n", parseFloat)
  .option("--packs <list>", "normalizer packs, comma-separated (http,log,path,ids,ansi,json)")
  .option("--junit <path>", "also write a JUnit XML report for CI")
  .option("--yes", "pre-approve if policy says 'ask'")
  .action(
    async (
      opts: {
        target: string;
        rebuild?: string;
        rebuildUrl?: string;
        vectorset: string;
        failUnder?: number;
        packs?: string;
        junit?: string;
        yes?: boolean;
      },
      cmd
    ) => {
      const g = globals(cmd);
      const input = {
        originalTargetId: opts.target,
        rebuildPath: opts.rebuild,
        rebuildUrl: opts.rebuildUrl,
        vectorSetId: opts.vectorset,
        failUnder: opts.failUnder,
        packs: opts.packs ? opts.packs.split(",").map((p) => p.trim()).filter(Boolean) : undefined
      };
      const core = coreFor({ store: g.store });
      const { report, passed, baseline } = await gatedCli("fea_verify_parity", input, g, { yes: opts.yes }, () =>
        core.verifyParity(input)
      );
      print({ report, passed, baseline });
      if (opts.junit) {
        const { path } = core.reportJunit({ reportId: report.id, outPath: opts.junit });
        console.error(`junit: ${path}`);
      }
      if (!passed) {
        console.error(`parity ${report.score} is below --fail-under ${opts.failUnder}`);
        process.exit(1);
      } else if (report.score < 100) {
        console.error(`parity ${report.score} — ${report.failed} failing vector(s); see report for diffs`);
      }
    }
  );

program
  .command("watch")
  .description("Re-run parity every time the rebuild changes (Ctrl-C to stop)")
  .requiredOption("--target <id>", "original target id")
  .option("--rebuild <path>", "path to the rebuilt binary (watched by mtime+size)")
  .option("--rebuild-url <url>", "base URL of the rebuilt API (watched by content hash)")
  .requiredOption("--vectorset <id>", "vector set id")
  .option("--packs <list>", "normalizer packs, comma-separated (http,log,path,ids,ansi,json)")
  .option("--fail-under <n>", "mark runs scoring below n as failed", parseFloat)
  .option("--interval-ms <n>", "poll interval in ms", "2000")
  .option("--yes", "pre-approve (required when policy says 'ask')")
  .action(
    async (
      opts: {
        target: string;
        rebuild?: string;
        rebuildUrl?: string;
        vectorset: string;
        packs?: string;
        failUnder?: number;
        intervalMs: string;
        yes?: boolean;
      },
      cmd
    ) => {
      const g = globals(cmd);
      const policy = PolicyEngine.loadFor(g.store, g.policy);
      const decision = policy.check("fea_verify_parity");
      if (decision === "deny") {
        console.error(`fea_verify_parity is denied by policy (${policy.source})`);
        process.exit(1);
      }
      if (decision === "ask" && !opts.yes) {
        console.error("fea watch needs --yes: approvals don't work in a watch loop");
        process.exit(1);
      }
      const core = coreFor({ store: g.store });
      console.log(`watching ${opts.rebuild ?? opts.rebuildUrl} (Ctrl-C to stop)`);
      await core.watchParity(
        {
          targetId: opts.target,
          rebuildPath: opts.rebuild,
          rebuildUrl: opts.rebuildUrl,
          vectorSetId: opts.vectorset,
          packs: opts.packs ? opts.packs.split(",").map((p) => p.trim()).filter(Boolean) : undefined,
          failUnder: opts.failUnder,
          pollMs: parseInt(opts.intervalMs, 10)
        },
        (e) => {
          const delta =
            e.baselineDelta === undefined
              ? ""
              : ` (Δ ${e.baselineDelta >= 0 ? "+" : ""}${e.baselineDelta} vs baseline)`;
          console.log(`run #${e.run} — score ${e.report.score}${delta} [${e.passed ? "ok" : "FAIL"}]`);
        }
      );
    }
  );

program
  .command("pin")
  .description("Pin a parity report as the baseline for a (target, vector set) pair")
  .requiredOption("--target <id>", "original target id")
  .requiredOption("--vectorset <id>", "vector set id")
  .requiredOption("--report <id>", "parity report id to pin")
  .action((opts: { target: string; vectorset: string; report: string }, cmd) => {
    const g = globals(cmd);
    print(
      coreFor({ store: g.store }).pinBaseline({
        targetId: opts.target,
        vectorSetId: opts.vectorset,
        reportId: opts.report
      })
    );
  });

program
  .command("diff")
  .description("Diff two vector sets: added / removed / changed vectors")
  .requiredOption("--a <id>", "first vector set id")
  .requiredOption("--b <id>", "second vector set id")
  .action((opts: { a: string; b: string }, cmd) => {
    const g = globals(cmd);
    print(coreFor({ store: g.store }).diffVectorSets({ a: opts.a, b: opts.b }));
  });

program
  .command("evolve")
  .description("Drive an agent to reimplement the target until parity converges (the self-rebuilding loop)")
  .requiredOption("--spec <id>", "behavior spec id")
  .requiredOption("--vectorset <id>", "vector set id to verify against")
  .requiredOption("--agent-cmd <bin>", "agent binary (no shell)")
  .option("--agent-arg <arg>", "agent argument (repeatable)", collect, [])
  .option("--target-score <n>", "stop when score reaches n", "100")
  .option("--max-attempts <n>", "give up after n attempts", "5")
  .option("--attempt-timeout-ms <n>", "kill the agent past n ms per attempt", "300000")
  .option("--packs <list>", "normalizer packs, comma-separated")
  .option("--yes", "pre-approve (required when policy says 'ask')")
  .action(
    async (
      opts: {
        spec: string;
        vectorset: string;
        agentCmd: string;
        agentArg: string[];
        targetScore: string;
        maxAttempts: string;
        attemptTimeoutMs: string;
        packs?: string;
        yes?: boolean;
      },
      cmd
    ) => {
      const g = globals(cmd);
      const policy = PolicyEngine.loadFor(g.store, g.policy);
      const decision = policy.check("fea_verify_parity");
      if (decision === "deny") {
        console.error(`fea_verify_parity is denied by policy (${policy.source})`);
        process.exit(1);
      }
      if (decision === "ask" && !opts.yes) {
        console.error("fea evolve needs --yes: approvals don't work in an evolve loop");
        process.exit(1);
      }
      const core = coreFor({ store: g.store });
      const evolution = await core.evolve(
        {
          specId: opts.spec,
          vectorSetId: opts.vectorset,
          agentCommand: opts.agentCmd,
          agentArgs: opts.agentArg,
          targetScore: parseFloat(opts.targetScore),
          maxAttempts: parseInt(opts.maxAttempts, 10),
          attemptTimeoutMs: parseInt(opts.attemptTimeoutMs, 10),
          packs: opts.packs ? opts.packs.split(",").map((p) => p.trim()).filter(Boolean) : undefined
        },
        (e) => {
          console.error(
            `attempt #${e.attempt} — score ${e.score} [${e.converged ? "CONVERGED" : "retrying"}]`
          );
        }
      );
      print(evolution);
    }
  );

program
  .command("fuzz")
  .description("Generate deterministic fuzz vectors from a spec (stored as a new vector set)")
  .requiredOption("--spec <id>", "spec id")
  .option("--count <n>", "how many vectors to generate", "20")
  .option("--seed <s>", "deterministic seed", "fea")
  .action(async (opts: { spec: string; count: string; seed: string }, cmd) => {
    const g = globals(cmd);
    print(
      coreFor({ store: g.store }).fuzzVectors({
        specId: opts.spec,
        count: parseInt(opts.count, 10),
        seed: opts.seed
      })
    );
  });

program
  .command("init")
  .description("Scaffold a FEA project directory (policy, workflow doc, example plans)")
  .argument("<name>", "project directory name")
  .option("--kind <kind>", "target kind: cli | http-api | native | apk", "cli")
  .option("--target <pathOrUrl>", "target to ingest right away")
  .option("--force", "overwrite a non-empty directory")
  .action(async (name: string, opts: { kind: string; target?: string; force?: boolean }) => {
    const { mkdirSync, writeFileSync, readdirSync, existsSync } = await import("node:fs");
    const { RECOMMENDED_POLICY } = await import("@fea/policy");
    const kinds = ["cli", "http-api", "native", "apk"];
    if (!kinds.includes(opts.kind)) {
      console.error(`--kind must be one of ${kinds.join(", ")}`);
      process.exit(1);
    }
    if (existsSync(name) && readdirSync(name).length > 0 && !opts.force) {
      console.error(`directory ${name} is not empty (use --force to overwrite)`);
      process.exit(1);
    }
    const storeDir = join(name, ".fea");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(name, "fea.policy.json"), JSON.stringify(RECOMMENDED_POLICY, null, 2) + "\n");
    const examplePlans =
      opts.kind === "http-api"
        ? JSON.stringify([{ name: "health", method: "GET", url: "http://127.0.0.1:3000/health" }], null, 2)
        : JSON.stringify([{ name: "example", argv: ["--help"] }], null, 2);
    writeFileSync(join(name, "capture-plans.json"), examplePlans + "\n");
    writeFileSync(join(name, "FEA.md"), initDoc(name, opts.kind));
    let targetLine = "# 1. fea ingest <path-or-url> --kind " + opts.kind + " --i-have-rights --store .fea";
    if (opts.target) {
      const t = coreFor({ store: storeDir }).ingestTarget({
        pathOrUrl: opts.target,
        kind: opts.kind as "cli" | "http-api" | "native" | "apk",
        iHaveRights: true
      });
      targetLine = `# 1. ingested: ${t.id} (${t.kind})`;
    }
    console.log(`initialized ${name}/`);
    console.log(targetLine);
    console.log(`# 2. edit capture-plans.json, then: fea capture --target <id> --plans "$(cat capture-plans.json)" --store .fea`);
    console.log(`# 3. fea spec --vectorset <id> --store .fea   # then plan, approve, verify`);
  });

program
  .command("report")
  .description("Render a self-contained HTML parity report")
  .requiredOption("--report <id>", "parity report id")
  .option("--out <path>", "output path (default: <store>/reports/<id>.html)")
  .action(async (opts: { report: string; out?: string }, cmd) => {
    const g = globals(cmd);
    const { path } = coreFor({ store: g.store }).reportHtml({
      reportId: opts.report,
      outPath: opts.out
    });
    console.log(path);
  });

program
  .command("pack")
  .description("Export a reproducible evidence pack (spec + report + provenance + manifest)")
  .requiredOption("--spec <id>", "spec id")
  .requiredOption("--report <id>", "parity report id")
  .action((opts: { spec: string; report: string }, cmd) => {
    const g = globals(cmd);
    print(
      coreFor({ store: g.store }).exportPack({
        specId: opts.spec,
        reportId: opts.report
      })
    );
  });

program
  .command("pack-verify")
  .description("Verify an evidence pack (manifest, hashes, spec, report, provenance chain)")
  .argument("<path>", "path to the exported pack directory")
  .action((path: string, cmd) => {
    const g = globals(cmd);
    const res = coreFor({ store: g.store }).verifyPack({ packPath: path });
    print(res);
    if (!res.valid) {
      console.error("pack verification FAILED");
      process.exit(1);
    }
  });

const twinCmd = program.command("twin").description("Publish, search, and fetch verified twins");

twinCmd
  .command("publish")
  .description("Publish a verified twin to the registry (pack must pass pack-verify)")
  .requiredOption("--pack <dir>", "path to the evidence pack directory")
  .requiredOption("--name <name>", "twin name (lowercase, digits, -, _)")
  .option("--twin-version <v>", "twin version (semver)", "1.0.0")
  .option("--description <text>", "what this twin is")
  .option("--pack-url <url>", "where others fetch the pack (defaults to the local pack path)")
  .option("--index <path>", "registry index path")
  .option("--yes", "pre-approve if policy says 'ask'")
  .action(
    (
      opts: {
        pack: string;
        name: string;
        twinVersion: string;
        description?: string;
        packUrl?: string;
        index?: string;
        yes?: boolean;
      },
      cmd
    ) => {
      const g = globals(cmd);
      const policy = PolicyEngine.loadFor(g.store, g.policy);
      const decision = policy.check("fea_twin_publish");
      if (decision === "deny") {
        console.error(`fea_twin_publish is denied by policy (${policy.source})`);
        process.exit(1);
      }
      if (decision === "ask" && !opts.yes) {
        console.error("twin publish needs --yes (or approve via fea_approve in MCP)");
        process.exit(1);
      }
      print(
        coreFor({ store: g.store }).twinPublish({
          packPath: opts.pack,
          name: opts.name,
          version: opts.twinVersion,
          description: opts.description,
          packLocation: opts.packUrl,
          indexPath: opts.index
        })
      );
    }
  );

twinCmd
  .command("search")
  .description("Search the twin registry")
  .argument("<query>", "search text")
  .option("--index <path>", "registry index path")
  .action((query: string, opts: { index?: string }, cmd) => {
    const g = globals(cmd);
    print(coreFor({ store: g.store }).twinSearch({ query, indexPath: opts.index }));
  });

twinCmd
  .command("get")
  .description("Fetch a twin: downloads the pack and verifies it on arrival")
  .argument("<name>", "twin name")
  .option("--twin-version <v>", "specific version (default: latest)")
  .option("--out-dir <dir>", "where to place the verified pack")
  .option("--index <path>", "registry index path")
  .action(
    async (
      name: string,
      opts: { twinVersion?: string; outDir?: string; index?: string },
      cmd
    ) => {
      const g = globals(cmd);
      print(
        await coreFor({ store: g.store }).twinGet({
          name,
          version: opts.twinVersion,
          outDir: opts.outDir,
          indexPath: opts.index
        })
      );
    }
  );

program
  .command("mcp")
  .description("Run the FEA MCP server over stdio (for agent registration)")
  .action(async (_opts: unknown, cmd) => {
    const g = globals(cmd);
    await runStdio(g.store);
  });

program
  .command("doctor")
  .description("Environment check (fea, node, sandbox backend, docker, REA reader)")
  .action(async (_opts: unknown, cmd) => {
    const g = globals(cmd);
    print(await coreFor({ store: g.store }).doctor());
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
