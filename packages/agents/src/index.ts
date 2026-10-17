import { fileURLToPath } from "node:url";

/**
 * Agent presets for `fea evolve`. A preset is a model-CLI wrapper that speaks
 * the evolve agent protocol (stdin: EvolveAgentRequest JSON, stdout:
 * {"rebuildPath": "..."}) so you don't have to write the wrapper yourself.
 *
 * The wrapper only ever sees the firewalled synthesis context (behavior) plus
 * failing vectors — the same guarantee as hand-written agents.
 */

/** Structural view of the evolve request — no dependency on @fea/mcp. */
export interface AgentPromptInput {
  attempt: number;
  maxAttempts: number;
  targetScore: number;
  lastScore: number | null;
  synthesisContext: {
    specId: string;
    surfaces: Array<{
      name: string;
      kind: string;
      signature: string;
      description?: string;
      ioExamples: Array<{ id: string; input: unknown; output: unknown }>;
    }>;
    dataModels?: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
    invariants?: Array<{ id: string; description: string }>;
    rules?: string[];
  };
  failingVectors: Array<{
    vectorId: string;
    field: string;
    expected: string;
    actual: string;
  }>;
}

export const AGENT_PRESETS = ["claude-code", "codex"] as const;
export type AgentPreset = (typeof AGENT_PRESETS)[number];

function renderInput(input: unknown): string {
  const v = input as { kind?: string; argv?: string[]; stdin?: string; method?: string; url?: string };
  if (v.kind === "cli") {
    return `argv=${JSON.stringify(v.argv ?? [])}${v.stdin ? ` stdin=${JSON.stringify(v.stdin)}` : ""}`;
  }
  if (v.kind === "http") {
    return `${v.method ?? ""} ${v.url ?? ""}`;
  }
  return JSON.stringify(input);
}

function renderOutput(output: unknown): string {
  const v = output as {
    kind?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    status?: number;
    body?: string;
  };
  if (v.kind === "cli") {
    return `stdout=${JSON.stringify(v.stdout ?? "")} stderr=${JSON.stringify(v.stderr ?? "")} exit=${v.exitCode}`;
  }
  if (v.kind === "http") {
    return `status=${v.status} body=${JSON.stringify((v.body ?? "").slice(0, 300))}`;
  }
  return JSON.stringify(output);
}

/**
 * Render the synthesis context + failing vectors into a model prompt.
 * Behavior only — the context never contains the original binary.
 */
export function renderAgentPrompt(req: AgentPromptInput, outPath: string): string {
  const ctx = req.synthesisContext;
  const lines: string[] = [];
  lines.push(
    "You are reimplementing a program from its OBSERVED BEHAVIOR ONLY.",
    "This is a clean-room task: you have never seen the original program.",
    "Reproduce exactly what it DOES. Never guess at internals.",
    "",
    "## Behavior specification",
    ""
  );
  for (const s of ctx.surfaces) {
    lines.push(`### ${s.name} (${s.kind}) — \`${s.signature}\``);
    if (s.description) lines.push(s.description);
    lines.push("Input/output examples:");
    for (const ex of s.ioExamples) {
      lines.push(`- input: ${renderInput(ex.input)}`);
      lines.push(`  output: ${renderOutput(ex.output)}`);
    }
    lines.push("");
  }
  if (ctx.dataModels?.length) {
    lines.push("### Data models");
    for (const d of ctx.dataModels) {
      lines.push(`- ${d.name}: ${d.fields.map((f) => `${f.name}: ${f.type}`).join(", ")}`);
    }
    lines.push("");
  }
  if (ctx.invariants?.length) {
    lines.push("### Invariants");
    for (const i of ctx.invariants) lines.push(`- ${i.description}`);
    lines.push("");
  }
  if (ctx.rules?.length) {
    lines.push("### Rules");
    for (const r of ctx.rules) lines.push(`- ${r}`);
    lines.push("");
  }
  lines.push(`## Attempt ${req.attempt} of ${req.maxAttempts} (target score: ${req.targetScore})`);
  if (req.lastScore === null) {
    lines.push("This is the first attempt.", "");
  } else {
    lines.push(`The previous attempt scored ${req.lastScore}.`, "");
  }
  if (req.failingVectors.length > 0) {
    lines.push("### Fix exactly these failures:");
    for (const f of req.failingVectors) {
      lines.push(`- vector ${f.vectorId} [${f.field}]:`);
      lines.push(`  expected: ${f.expected.slice(0, 300)}`);
      lines.push(`  actual:   ${f.actual.slice(0, 300)}`);
    }
    lines.push("");
  }
  lines.push(
    "## Your task",
    "Write ONE complete, runnable program implementing EXACTLY the behavior above.",
    `It will be saved as ${outPath} and executed directly; include a proper shebang line.`,
    "Output ONLY the raw program code. No markdown fences, no explanations, no commentary."
  );
  return lines.join("\n");
}

/** Strip markdown fences if the model wrapped its code anyway. */
export function stripCodeFences(s: string): string {
  const m = s.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return `${(m ? m[1] : s).trim()}\n`;
}

export interface PresetResolution {
  command: string;
  args: string[];
}

/**
 * Resolve a preset name to an agent command honoring the evolve protocol.
 * The wrapper script lives next to this module's dist output.
 */
export function resolveAgentPreset(
  preset: string,
  opts?: { outExt?: string; outDir?: string }
): PresetResolution {
  if (!(AGENT_PRESETS as readonly string[]).includes(preset)) {
    throw new Error(`unknown agent preset "${preset}" (known: ${AGENT_PRESETS.join(", ")})`);
  }
  const wrapper = fileURLToPath(new URL("./wrappers/agent.js", import.meta.url));
  return {
    command: "node",
    args: [
      wrapper,
      "--model",
      preset,
      "--out-ext",
      opts?.outExt ?? "js",
      "--out-dir",
      opts?.outDir ?? process.cwd()
    ]
  };
}
