import { describe, expect, it } from "vitest";
import {
  renderAgentPrompt,
  resolveAgentPreset,
  stripCodeFences,
  type AgentPromptInput
} from "../src/index.js";

function req(): AgentPromptInput {
  return {
    attempt: 2,
    maxAttempts: 5,
    targetScore: 100,
    lastScore: 40,
    synthesisContext: {
      specId: "spec_1",
      surfaces: [
        {
          name: "adder",
          kind: "cli-command",
          signature: "adder <numbers...>",
          description: "adds numbers",
          ioExamples: [
            {
              id: "vec_1",
              input: { kind: "cli", argv: ["2", "3"] },
              output: { kind: "cli", stdout: "5\n", stderr: "", exitCode: 0 }
            }
          ]
        }
      ],
      rules: ["Reimplement OBSERVED BEHAVIOR ONLY."]
    },
    failingVectors: [{ vectorId: "vec_1", field: "stdout", expected: "5\n", actual: "broken\n" }]
  };
}

describe("renderAgentPrompt", () => {
  it("renders behavior, failing vectors, and the code-only instruction", () => {
    const p = renderAgentPrompt(req(), "/tmp/fea-evolve-2.js");
    expect(p).toContain("adder <numbers...>");
    expect(p).toContain("Attempt 2 of 5");
    expect(p).toContain("scored 40");
    expect(p).toContain("vec_1 [stdout]");
    expect(p).toContain("expected: 5");
    expect(p).toContain("Output ONLY the raw program code");
    // firewall: the prompt carries behavior, and the renderer adds no paths
    expect(p).not.toContain("/bin/");
  });
});

describe("stripCodeFences", () => {
  it("extracts fenced code", () => {
    expect(stripCodeFences("```js\nconsole.log(1);\n```")).toBe("console.log(1);\n");
  });
  it("passes through raw code", () => {
    expect(stripCodeFences("console.log(1);\n")).toBe("console.log(1);\n");
  });
});

describe("resolveAgentPreset", () => {
  it("resolves known presets to the wrapper", () => {
    const r = resolveAgentPreset("codex", { outExt: "py", outDir: "/tmp/x" });
    expect(r.command).toBe("node");
    expect(r.args[0]).toMatch(/wrappers\/agent\.js$/);
    expect(r.args).toContain("codex");
    expect(r.args).toContain("py");
  });
  it("rejects unknown presets", () => {
    expect(() => resolveAgentPreset("gpt-9")).toThrow(/unknown agent preset/);
  });
});
