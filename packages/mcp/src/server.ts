import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FeaCore, FEA_VERSION } from "./core.js";
import { FeaStore } from "./store.js";

const TargetKindSchema = z.enum(["cli", "http-api"]);

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
    "Black-box capture: run the target with each plan and record I/O vectors. No internals are read.",
    {
      targetId: z.string(),
      plans: z
        .array(z.union([CliPlanSchema, HttpPlanSchema]))
        .describe("Capture plans (CLI argv plans or HTTP request plans)")
    },
    (args) => run(() => core.captureBehavior({ targetId: args.targetId, plans: args.plans }))
  );

  server.tool(
    "fea_extract_spec",
    "Build a validated BehaviorSpec (v1.0) from a captured vector set.",
    { vectorSetId: z.string() },
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
    "Differential parity: run the original target and a rebuild on the same vectors; returns a parity score + failing vectors.",
    {
      originalTargetId: z.string(),
      rebuildPath: z.string().describe("Absolute path to the rebuilt binary"),
      vectorSetId: z.string(),
      seed: z.string().optional()
    },
    (args) => run(() => core.verifyParity(args))
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
