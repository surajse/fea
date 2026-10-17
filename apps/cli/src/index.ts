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

const program = new Command();
program
  .name("fea")
  .description("Forward Engineer Anything — verified reimplementation loop")
  .version("0.4.0")
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
  .requiredOption("--rebuild <path>", "absolute path to the rebuilt binary")
  .requiredOption("--vectorset <id>", "vector set id")
  .option("--fail-under <n>", "CI mode: exit 1 when score is below n", parseFloat)
  .option("--packs <list>", "normalizer packs, comma-separated (http,log,path,ids)")
  .option("--yes", "pre-approve if policy says 'ask'")
  .action(
    async (
      opts: {
        target: string;
        rebuild: string;
        vectorset: string;
        failUnder?: number;
        packs?: string;
        yes?: boolean;
      },
      cmd
    ) => {
      const g = globals(cmd);
      const input = {
        originalTargetId: opts.target,
        rebuildPath: opts.rebuild,
        vectorSetId: opts.vectorset,
        failUnder: opts.failUnder,
        packs: opts.packs ? opts.packs.split(",").map((p) => p.trim()).filter(Boolean) : undefined
      };
      const { report, passed } = await gatedCli("fea_verify_parity", input, g, { yes: opts.yes }, () =>
        coreFor({ store: g.store }).verifyParity(input)
      );
      print({ report, passed });
      if (!passed) {
        console.error(`parity ${report.score} is below --fail-under ${opts.failUnder}`);
        process.exit(1);
      } else if (report.score < 100) {
        console.error(`parity ${report.score} — ${report.failed} failing vector(s); see report for diffs`);
      }
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
