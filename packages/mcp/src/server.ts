import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PolicyEngine } from "@fea/policy";
import { FeaCore, FEA_VERSION } from "./core.js";
import { FeaStore } from "./store.js";

const TargetKindSchema = z.enum(["cli", "http-api", "native", "apk"]);

const CliPlanSchema = z.object({
  name: z.string().optional(),
  argv: z.array(z.string()),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
});

const HttpPlanSchema = z.object({
  name: z.string().optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
});

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): TextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a core operation, converting throws into MCP tool errors. */
async function run(fn: () => Promise<unknown> | unknown): Promise<TextResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Build the FEA MCP server: 9 tools implementing the
 * ingest → spec → synthesize → verify → export loop.
 */
export function createFieaServer(storeDir: string): { server: McpServer; core: FeaCore } {
  const core = new FeaCore(new FeaStore(storeDir));
  const server = new McpServer({ name: "fea", version: FEA_VERSION });
  const policy = PolicyEngine.loadFor(storeDir);

  /**
   * Policy gate for execution-class tools. "allow" runs, "ask" stages an
   * approval (fea_approve completes it), "deny" refuses with an error.
   */
  const gated = (
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<unknown> | unknown
  ): Promise<TextResult> => {
    const decision = policy.check(toolName);
    if (decision === "deny") {
      return Promise.resolve(err(`tool "${toolName}" is denied by policy (${policy.source})`));
    }
    if (decision === "ask") {
      return run(() => core.requestToolApproval(toolName, args));
    }
    return run(fn);
  };

  server.tool(
    "fea_ingest_target",
    "Register a target you are authorized to analyze (CLI binary or HTTP API). Requires explicit iHaveRights confirmation.",
    {
      pathOrUrl: z.string().describe("Absolute path to a CLI binary, or base URL of an HTTP API"),
      kind: TargetKindSchema,
      iHaveRights: z.boolean().describe("Confirm you own / are licensed to analyze this target")
    },
    (args) => run(() => core.ingestTarget(args))
  );

  server.tool(
    "fea_capture_behavior",
    "Black-box capture: run the target with each plan and record I/O vectors. No internals are read. May require approval per policy.",
    {
      targetId: z.string(),
      plans: z
        .array(z.union([CliPlanSchema, HttpPlanSchema]))
        .describe("Capture plans (CLI argv plans or HTTP request plans)")
    },
    (args) =>
      gated("fea_capture_behavior", args as Record<string, unknown>, () =>
        core.captureBehavior({ targetId: args.targetId, plans: args.plans })
      )
  );

  server.tool(
    "fea_read",
    "Ask the REA reader for analysis findings about a target (e.g. list exports). Findings are stored as evidence on the analysis side. Use prelude for session workflows (e.g. open_binary first).",
    {
      targetId: z.string(),
      tool: z.string().describe("Reader tool name, e.g. a REA MCP tool"),
      args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the reader tool"),
      prelude: z
        .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }))
        .optional()
        .describe("Tool calls to run first in the same reader session"),
      readerCommand: z.array(z.string()).optional().describe("Custom reader stdio command (default: rea mcp)"),
      readerUrl: z.string().optional().describe("Reader Streamable-HTTP URL alternative"),
      readerProxyUrl: z
        .string()
        .optional()
        .describe("`fea reader serve` proxy URL for a persistent reader session"),
      readerToken: z.string().optional().describe("Bearer token for the reader proxy")
    },
    (args) =>
      gated("fea_read", args as Record<string, unknown>, () => core.readWithReader(args))
  );

  server.tool(
    "fea_approve",
    "Approve a policy-gated tool call staged by an 'ask' decision. Consumes the token and executes the call. Always allowed.",
    { approvalToken: z.string() },
    (args) => run(() => core.approveTool(args))
  );

  server.tool(
    "fea_fuzz",
    "Generate deterministic fuzz vectors from a spec and store them as a new vector set (recorded + generated).",
    {
      specId: z.string(),
      count: z.number().int().positive().max(500).optional(),
      seed: z.string().optional()
    },
    (args) => run(() => core.fuzzVectors(args))
  );

  server.tool(
    "fea_report",
    "Render a self-contained HTML parity report (no external assets).",
    { reportId: z.string(), outPath: z.string().optional() },
    (args) => run(() => core.reportHtml(args))
  );

  server.tool(
    "fea_verify_pack",
    "Verify an evidence pack: manifest integrity, file hashes, spec schema, report identity, and the hash-chained provenance log. FEA checking its own homework.",
    { packPath: z.string().describe("Path to the exported pack directory") },
    (args) => run(() => core.verifyPack(args))
  );

  server.tool(
    "fea_diff_vectorsets",
    "Diff two vector sets: which vectors were added, removed, or changed (same input, different expectations/output).",
    {
      a: z.string().describe("First vector set id"),
      b: z.string().describe("Second vector set id")
    },
    (args) => run(() => core.diffVectorSets(args))
  );

  server.tool(
    "fea_extract_spec",
    "Build a validated BehaviorSpec (v1.0) from a captured vector set, optionally with reader notes as evidence.",
    { vectorSetId: z.string(), notesId: z.string().optional() },
    (args) => run(() => core.extractSpec(args))
  );

  server.tool(
    "fea_get_spec",
    "Fetch a stored BehaviorSpec by id (re-validated on read).",
    { specId: z.string() },
    (args) => run(() => core.getSpec(args))
  );

  server.tool(
    "fea_plan_rebuild",
    "Propose a rebuild plan for a spec. Returns a one-time approval token — synthesis requires human approval.",
    { specId: z.string() },
    (args) => run(() => core.planRebuild(args))
  );

  server.tool(
    "fea_synthesis_context",
    "Get the FIREWALLED synthesis context for an approved plan. Contains behavior only — never decompiled code, addresses or symbols.",
    { specId: z.string(), approvalToken: z.string() },
    (args) => run(() => core.synthesisContext(args))
  );

  server.tool(
    "fea_verify_parity",
    "Differential parity: run the original target and a rebuild on the same vectors; returns a parity score + failing vectors. CLI/native: rebuildPath (binary). HTTP: rebuildUrl (base URL). failUnder enables CI mode. May require approval per policy.",
    {
      originalTargetId: z.string(),
      rebuildPath: z.string().optional().describe("Absolute path to the rebuilt binary (cli/native)"),
      rebuildUrl: z.string().optional().describe("Base URL of the rebuilt API (http-api)"),
      vectorSetId: z.string(),
      seed: z.string().optional(),
      failUnder: z.number().min(0).max(100).optional().describe("CI mode: fail when score is below this"),
      packs: z
        .array(z.string())
        .optional()
        .describe("Normalizer packs (http, log, path, ids, ansi, json), additive on defaults")
    },
    (args) =>
      gated("fea_verify_parity", args as Record<string, unknown>, () => core.verifyParity(args))
  );

  server.tool(
    "fea_export_pack",
    "Export a reproducible evidence pack: spec + parity report + provenance log + manifest with sha256.",
    { specId: z.string(), reportId: z.string() },
    (args) => run(() => core.exportPack(args))
  );

  server.tool(
    "fea_doctor",
    "Environment check: versions and platform.",
    { verbose: z.boolean().optional() },
    () => run(() => core.doctor())
  );

  return { server, core };
}

/** Run the MCP server over stdio (for `fea mcp` and agent registration). */
export async function runStdio(storeDir: string): Promise<void> {
  const { server } = createFieaServer(storeDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
