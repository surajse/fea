#!/usr/bin/env node
import { join } from "node:path";
import { Command } from "commander";
import { FeaCore, FeaStore, runStdio } from "@fea/mcp";

function coreFor(opts: { store?: string }): FeaCore {
  const dir = opts.store ?? join(process.cwd(), ".fea");
  return new FeaCore(new FeaStore(dir));
}

function print(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

const program = new Command();
program
  .name("fea")
  .description("Forward Engineer Anything — verified reimplementation loop")
  .version("0.2.0")
  .option("--store <dir>", "FEA store directory", join(process.cwd(), ".fea"));

program
  .command("ingest")
  .description("Register a target you are authorized to analyze")
  .argument("<pathOrUrl>", "absolute path to a CLI/native binary, or base URL of an HTTP API")
  .option("--kind <kind>", "cli | http-api | native", "cli")
  .option("--i-have-rights", "confirm you own / are licensed to analyze this target")
  .action((pathOrUrl: string, opts: { kind: string; iHaveRights?: boolean }, cmd) => {
    const global = cmd.optsWithGlobals?.() ?? {};
    if (opts.kind !== "cli" && opts.kind !== "http-api" && opts.kind !== "native") {
      console.error("--kind must be cli, http-api or native");
      process.exit(1);
    }
    print(coreFor({ store: (global as { store: string }).store }).ingestTarget({
      pathOrUrl,
      kind: opts.kind as "cli" | "http-api" | "native",
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
  .action(
    async (
      opts: { target: string; tool: string; args: string; prelude?: string; readerCmd?: string },
      cmd
    ) => {
      const global = cmd.optsWithGlobals?.() ?? {};
      print(
        await coreFor({ store: (global as { store: string }).store }).readWithReader({
          targetId: opts.target,
          tool: opts.tool,
          args: JSON.parse(opts.args) as Record<string, unknown>,
          prelude: opts.prelude
            ? (JSON.parse(opts.prelude) as Array<{ tool: string; args?: Record<string, unknown> }>)
            : undefined,
          readerCommand: opts.readerCmd ? opts.readerCmd.split(" ") : undefined
        })
      );
    }
  );

program
  .command("capture")
  .description("Black-box capture: run the target with each plan, record I/O vectors")
  .requiredOption("--target <id>", "target id from ingest")
  .requiredOption("--plans <json>", 'JSON array, e.g. \'[{"name":"add","argv":["2","3"]}]\'')
  .action(async (opts: { target: string; plans: string }, cmd) => {
    const global = cmd.optsWithGlobals?.() ?? {};
    print(
      await coreFor({ store: (global as { store: string }).store }).captureBehavior({
        targetId: opts.target,
        plans: JSON.parse(opts.plans) as Array<Record<string, unknown>>
      })
    );
  });

program
  .command("spec")
  .description("Build a validated BehaviorSpec from a captured vector set")
  .requiredOption("--vectorset <id>", "vector set id from capture")
  .option("--notes <id>", "reader notes id to attach as evidence")
  .action((opts: { vectorset: string; notes?: string }, cmd) => {
    const global = cmd.optsWithGlobals?.() ?? {};
    print(
      coreFor({ store: (global as { store: string }).store }).extractSpec({
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
    const global = cmd.optsWithGlobals?.() ?? {};
    print(coreFor({ store: (global as { store: string }).store }).planRebuild({ specId: opts.spec }));
  });

program
  .command("synth-context")
  .description("Get the FIREWALLED synthesis context (behavior only)")
  .requiredOption("--spec <id>", "spec id")
  .requiredOption("--token <token>", "approval token from plan")
  .action((opts: { spec: string; token: string }, cmd) => {
    const global = cmd.optsWithGlobals?.() ?? {};
    print(
      coreFor({ store: (global as { store: string }).store }).synthesisContext({
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
  .action(async (opts: { target: string; rebuild: string; vectorset: string; failUnder?: number }, cmd) => {
    const global = cmd.optsWithGlobals?.() ?? {};
    const { report, passed } = await coreFor({ store: (global as { store: string }).store }).verifyParity({
      originalTargetId: opts.target,
      rebuildPath: opts.rebuild,
      vectorSetId: opts.vectorset,
      failUnder: opts.failUnder
    });
    print({ report, passed });
    if (!passed) {
      console.error(`parity ${report.score} is below --fail-under ${opts.failUnder}`);
      process.exit(1);
    } else if (report.score < 100) {
      console.error(`parity ${report.score} — ${report.failed} failing vector(s); see report for diffs`);
    }
  });

program
  .command("pack")
  .description("Export a reproducible evidence pack (spec + report + provenance + manifest)")
  .requiredOption("--spec <id>", "spec id")
  .requiredOption("--report <id>", "parity report id")
  .action((opts: { spec: string; report: string }, cmd) => {
    const global = cmd.optsWithGlobals?.() ?? {};
    print(
      coreFor({ store: (global as { store: string }).store }).exportPack({
        specId: opts.spec,
        reportId: opts.report
      })
    );
  });

program
  .command("mcp")
  .description("Run the FEA MCP server over stdio (for agent registration)")
  .action(async (_opts: unknown, cmd) => {
    const global = cmd.optsWithGlobals?.() ?? {};
    await runStdio((global as { store: string }).store);
  });

program
  .command("doctor")
  .description("Environment check (fea, node, sandbox backend, docker, REA reader)")
  .action(async (_opts: unknown, cmd) => {
    const global = cmd.optsWithGlobals?.() ?? {};
    print(await coreFor({ store: (global as { store: string }).store }).doctor());
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
