import type { TargetDescriptor, Vector } from "../src/schema.js";

const target: TargetDescriptor = {
  id: "tgt_ab12cd34",
  kind: "cli",
  pathOrUrl: "/tmp/adder",
  sha256: "a".repeat(64),
  capturedAt: new Date().toISOString()
};

function cliVector(id: string, argv: string[], stdout: string, exitCode = 0): Vector {
  return {
    id,
    weight: 2,
    input: { kind: "cli", argv, stdin: undefined },
    output: { kind: "cli", stdout, stderr: "", exitCode },
    recordedAt: new Date().toISOString()
  };
}

export function minimalSpec() {
  return {
    id: "spec_test01",
    version: "1.0",
    target,
    surfaces: [
      {
        name: "add",
        kind: "cli-command",
        signature: "adder add [...numbers]",
        ioExampleIds: ["v1", "v2"]
      }
    ],
    dataModels: [],
    invariants: [],
    ioExamples: [
      cliVector("v1", ["add", "2", "3"], "5\n"),
      cliVector("v2", ["add", "-1", "1"], "0\n")
    ],
    evidence: [
      { itemId: "add", kind: "capture", ref: "vectors:v1,v2" },
      { itemId: "v1", kind: "capture", ref: "vector:v1" },
      { itemId: "v2", kind: "capture", ref: "vector:v2" }
    ]
  };
}

export function cliVectors(): Vector[] {
  return [
    cliVector("v1", ["add", "2", "3"], "5\n"),
    cliVector("v2", ["add", "-1", "1"], "0\n"),
    cliVector("v3", ["--help"], "usage: adder\n")
  ];
}

export { target };
