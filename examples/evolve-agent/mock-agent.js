#!/usr/bin/env node
/**
 * Mock evolve agent — demonstrates the `fea evolve` agent protocol.
 *
 * Protocol:
 *   stdin:  EvolveAgentRequest JSON
 *           { attempt, maxAttempts, targetScore, lastScore,
 *             synthesisContext, failingVectors }
 *   stdout: {"rebuildPath": "/abs/path/to/rebuild"}   (JSON, nothing else)
 *   stderr: free-form logs (shown to the user)
 *
 * The agent sees ONLY the firewalled synthesis context (behavior) plus the
 * previous attempt's failing vectors — never the original binary. This mock
 * is intentionally scripted: attempt 1 writes a stub, later attempts write a
 * correct reimplementation. Wire YOUR agent here: an LLM CLI wrapper, a
 * code-generation script, anything that speaks this protocol.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  console.error(`[mock-agent] attempt ${req.attempt}/${req.maxAttempts}, lastScore=${req.lastScore}`);
  console.error(
    `[mock-agent] failing vectors: ${req.failingVectors.map((f) => `${f.vectorId}[${f.field}]`).join(", ") || "none"}`
  );

  const rebuild = join(tmpdir(), `fea-mock-rebuild-${req.attempt}.js`);
  const src =
    req.attempt === 1
      ? "#!/usr/bin/env node\nconsole.log('todo: implement me');\n"
      : "#!/usr/bin/env node\n" +
        "const ns = process.argv.slice(2).map(Number);\n" +
        "if (ns.some(isNaN)) { console.error('not a number'); process.exit(1); }\n" +
        "console.log(ns.reduce((a, b) => a + b, 0));\n";
  writeFileSync(rebuild, src, { mode: 0o755 });
  console.error(`[mock-agent] wrote ${rebuild}`);
  console.log(JSON.stringify({ rebuildPath: rebuild }));
});
