import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PolicyDecision = "allow" | "ask" | "deny";

export interface PolicyConfig {
  version: "1.0";
  /** default when a tool has no explicit rule */
  default?: PolicyDecision;
  tools?: Record<string, PolicyDecision>;
}

const DECISIONS: PolicyDecision[] = ["allow", "ask", "deny"];

/**
 * Recommended starting policy: anything that executes target binaries or
 * spawns the REA reader asks first; pure reads are free.
 */
export const RECOMMENDED_POLICY: PolicyConfig = {
  version: "1.0",
  default: "allow",
  tools: {
    fea_capture_behavior: "ask",
    fea_verify_parity: "ask",
    fea_read: "ask"
  }
};

/**
 * Allow/ask/deny policy engine. Deterministic — no LLM involved.
 * `ask` means: the interface layer must obtain human approval (MCP:
 * fea_approve; CLI: --yes or `fea approve`) before executing.
 */
export class PolicyEngine {
  /** where this policy came from (for messages and audit) */
  public readonly source: string;

  constructor(private config: PolicyConfig, source = "default:allow-all") {
    this.source = source;
    this.validate();
  }

  private validate(): void {
    if (this.config.version !== "1.0") {
      throw new Error(`unsupported policy version: ${String(this.config.version)}`);
    }
    const bad: string[] = [];
    if (this.config.default && !DECISIONS.includes(this.config.default)) bad.push(`default=${this.config.default}`);
    for (const [tool, d] of Object.entries(this.config.tools ?? {})) {
      if (!DECISIONS.includes(d)) bad.push(`${tool}=${d}`);
    }
    if (bad.length > 0) {
      throw new Error(`invalid policy decisions (want allow|ask|deny): ${bad.join(", ")}`);
    }
  }

  check(toolName: string): PolicyDecision {
    return this.config.tools?.[toolName] ?? this.config.default ?? "allow";
  }

  /** Load order: explicit file > FEA_POLICY env > <storeDir>/fea.policy.json > ./fea.policy.json > allow-all. */
  static loadFor(storeDir: string, overrideFile?: string): PolicyEngine {
    const candidates = [
      overrideFile,
      process.env.FEA_POLICY,
      join(storeDir, "fea.policy.json"),
      join(process.cwd(), "fea.policy.json")
    ].filter((f): f is string => typeof f === "string" && f.length > 0);
    for (const file of candidates) {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as PolicyConfig;
        return new PolicyEngine(raw, `file:${file}`);
      }
    }
    return new PolicyEngine({ version: "1.0", default: "allow" });
  }
}
