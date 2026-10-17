import { runCommand } from "@fea/sandbox";
import type { Vector } from "@fea/spec";

export interface CliCapturePlan {
  /** label for the vector id */
  name?: string;
  argv: string[];
  stdin?: string;
  timeoutMs?: number;
}

/**
 * Black-box capture: run the CLI binary with each plan and record
 * argv/stdin -> stdout/stderr/exitCode. Nothing about internals is read.
 */
export async function captureCli(
  binaryPath: string,
  plans: CliCapturePlan[]
): Promise<Vector[]> {
  const vectors: Vector[] = [];
  let n = 0;
  for (const plan of plans) {
    n += 1;
    const result = await runCommand(binaryPath, plan.argv, {
      stdin: plan.stdin,
      timeoutMs: plan.timeoutMs
    });
    vectors.push({
      id: `vec_${plan.name ?? n}`,
      weight: 2,
      input: { kind: "cli", argv: plan.argv, stdin: plan.stdin },
      output: {
        kind: "cli",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      },
      recordedAt: new Date().toISOString()
    });
  }
  return vectors;
}
