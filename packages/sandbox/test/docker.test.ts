import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  DockerBackend,
  SpawnBackend,
  activeBackend,
  backendName,
  dockerAvailable,
  runCommand,
  setBackend
} from "../src/index.js";

/** A fake `docker` CLI: finds the image token, execs the rest locally. */
function fakeDockerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fea-"));
  const file = join(dir, "docker");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "info") { console.log("99.0-fake"); process.exit(0); }
const imgIdx = args.findIndex((a) => a === "fake:latest");
if (imgIdx === -1) { console.error("no image"); process.exit(2); }
const cmd = args.slice(imgIdx + 1);
const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
`
  );
  chmodSync(file, 0o755);
  return dir;
}

const withPath = (dir: string) => ({ PATH: `${dir}:${process.env.PATH ?? ""}` });

describe("DockerBackend", () => {
  it("runs commands through the docker CLI", async () => {
    const dir = fakeDockerDir();
    const backend = new DockerBackend("fake:latest");
    const r = await backend.run("echo", ["hi"], { env: withPath(dir) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi\n");
  });

  it("propagates failures", async () => {
    const dir = fakeDockerDir();
    const backend = new DockerBackend("fake:latest");
    const r = await backend.run(process.execPath, ["-e", "process.exit(3);"], {
      env: withPath(dir)
    });
    expect(r.exitCode).toBe(3);
  });
});

describe("backend selection", () => {
  const saved = process.env.FEA_SANDBOX;
  afterEach(() => {
    if (saved === undefined) delete process.env.FEA_SANDBOX;
    else process.env.FEA_SANDBOX = saved;
    setBackend(undefined);
  });

  it("defaults to spawn", () => {
    expect(activeBackend()).toBeInstanceOf(SpawnBackend);
    expect(backendName()).toBe("spawn");
  });

  it("honors FEA_SANDBOX=docker", () => {
    process.env.FEA_SANDBOX = "docker";
    expect(backendName()).toBe("docker");
  });

  it("honors programmatic override", () => {
    setBackend(new DockerBackend("fake:latest"));
    expect(backendName()).toBe("docker");
  });

  it("runCommand follows the override", async () => {
    const dir = fakeDockerDir();
    process.env.PATH = `${dir}:${process.env.PATH}`;
    setBackend(new DockerBackend("fake:latest"));
    const r = await runCommand("echo", ["via-docker"]);
    expect(r.stdout).toBe("via-docker\n");
  });
});

describe("dockerAvailable", () => {
  it("detects the fake docker CLI", async () => {
    const dir = fakeDockerDir();
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${savedPath}`;
    try {
      expect(await dockerAvailable()).toBe(true);
    } finally {
      process.env.PATH = savedPath ?? "";
    }
  });

  it("returns false when docker is missing", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-dir";
    try {
      expect(await dockerAvailable()).toBe(false);
    } finally {
      process.env.PATH = savedPath ?? "";
    }
  });
});
