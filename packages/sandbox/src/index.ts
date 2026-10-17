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

export interface SandboxBackend {
  readonly name: string;
  run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Core bounded-spawn implementation. Never uses a shell (no shell
 * injection). Shared by all backends; DockerBackend just prefixes the
 * docker CLI invocation.
 */
export function spawnBounded(
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
    child.on("close", (code: number | null) => finish(timedOut ? -1 : (code ?? -1)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // the close event follows and calls finish
    }, timeoutMs);
    timer.unref?.();

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/** Default backend: direct child processes with hard bounds. */
export class SpawnBackend implements SandboxBackend {
  readonly name = "spawn";
  run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
    return spawnBounded(cmd, args, opts);
  }
}

/**
 * Docker backend: every run becomes
 * `docker run --rm -i --network none --memory 512m --cpus 1 …`.
 * Selected with FEA_SANDBOX=docker (image via FEA_DOCKER_IMAGE).
 * v0.2: interface + wiring are real; Docker itself was not available on
 * the build VM, so live-container runs are exercised via a fake docker
 * shim in tests and documented in README.
 */
export class DockerBackend implements SandboxBackend {
  readonly name = "docker";
  constructor(private image = "node:24-slim") {}

  run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--memory",
      "512m",
      "--cpus",
      "1",
      ...(opts.cwd ? ["--workdir", "/work", "--volume", `${opts.cwd}:/work`] : []),
      this.image,
      cmd,
      ...args
    ];
    return spawnBounded("docker", dockerArgs, opts);
  }
}

let overrideBackend: SandboxBackend | undefined;

/** Override the backend programmatically (tests, embedding). */
export function setBackend(backend: SandboxBackend | undefined): void {
  overrideBackend = backend;
}

export function activeBackend(): SandboxBackend {
  if (overrideBackend) return overrideBackend;
  if (process.env.FEA_SANDBOX === "docker") {
    return new DockerBackend(process.env.FEA_DOCKER_IMAGE || undefined);
  }
  return new SpawnBackend();
}

export function backendName(): string {
  return activeBackend().name;
}

/**
 * Run a command through the active backend.
 * Network access is whatever the backend gives the process — the spawn
 * backend inherits the OS environment; the docker backend disables
 * networking by default.
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  return activeBackend().run(cmd, args, opts);
}

/**
 * Is the docker CLI usable? Always probed via the spawn backend so it
 * never recurses when FEA_SANDBOX=docker.
 */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const r = await new SpawnBackend().run(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { timeoutMs: 8000 }
    );
    return r.exitCode === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export * from "./harness.js";
