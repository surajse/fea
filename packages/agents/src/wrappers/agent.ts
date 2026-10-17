import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SpawnBackend } from "@fea/sandbox";
import { renderAgentPrompt, stripCodeFences, type AgentPromptInput } from "../index.js";

/**
 * Model-CLI wrapper for `fea evolve`. Speaks the evolve agent protocol:
 * stdin = EvolveAgentRequest JSON, stdout = {"rebuildPath": "..."}.
 *
 * Usage: node agent.js --model <claude-code|codex> --out-ext <ext> --out-dir <dir>
 *
 * The model sees ONLY the firewalled synthesis context + failing vectors.
 * Requires the model CLI to be installed and authenticated (claude / codex).
 */
function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  console.error(`missing required argument ${name}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const model = arg("--model");
  const outExt = arg("--out-ext", "js");
  const outDir = arg("--out-dir", process.cwd());

  const req = JSON.parse(readFileSync(0, "utf8")) as AgentPromptInput;
  const outPath = join(outDir, `fea-evolve-${req.attempt}.${outExt}`);
  const prompt = renderAgentPrompt(req, outPath);

  let command: string;
  let args: string[];
  let stdin: string | undefined;
  if (model === "claude-code") {
    command = "claude";
    args = ["-p", prompt, "--output-format", "text"];
  } else if (model === "codex") {
    command = "codex";
    args = ["exec", "-"];
    stdin = prompt;
  } else {
    console.error(`unknown model "${model}" (expected claude-code or codex)`);
    process.exit(1);
  }

  const res = await new SpawnBackend().run(command, args, {
    stdin,
    timeoutMs: 600_000,
    maxOutputBytes: 4_000_000
  });
  if (res.timedOut) {
    console.error("model CLI timed out after 10 minutes");
    process.exit(1);
  }
  if (res.exitCode !== 0) {
    console.error(`model CLI exited ${res.exitCode}: ${res.stderr.slice(0, 500)}`);
    process.exit(1);
  }
  const code = stripCodeFences(res.stdout);
  if (!code.trim()) {
    console.error("model CLI returned empty output");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, code);
  chmodSync(outPath, 0o755);
  console.log(JSON.stringify({ rebuildPath: outPath }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
