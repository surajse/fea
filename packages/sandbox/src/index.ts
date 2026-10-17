import { spawn } from "node:child_process";

export interface RunOptions {
  /** wall-clock timeout; the process is SIGKILLed past it */
  timeoutMs?: number;
  /** truncate stdout/stderr past this many bytes each */
  maxOutputBytes?: number;
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** -1 when killed by timeout */
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Run a command with hard bounds. Never uses a shell (no shell injection).
 * Network access is whatever the OS gives the process — v0.2 adds a
 * pluggable isolation backend (Docker) behind this same interface.
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        truncated,
        durationMs: Date.now() - started
      });
    };

    const append = (chunk: Buffer, which: "out" | "err") => {
      let text = chunk.toString("utf8");
      const current = which === "out" ? stdout : stderr;
      if (current.length + text.length > maxOutputBytes) {
        text = text.slice(0, maxOutputBytes - current.length);
        truncated = true;
      }
      if (which === "out") stdout += text;
      else stderr += text;
    };

    child.stdout.on("data", (c: Buffer) => append(c, "out"));
    child.stderr.on("data", (c: Buffer) => append(c, "err"));
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(timedOut ? -1 : (code ?? -1)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // close event will follow and call finish
    }, timeoutMs);
    timer.unref?.();

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
