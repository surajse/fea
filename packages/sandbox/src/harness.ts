import { execFile } from "node:child_process";

/**
 * AppHarness — the seam between FEA and a launched app.
 *
 * v0.6 ships the interface, a ManualHarness, and android tool probes.
 * An emulator-backed harness needs the Android SDK on the machine;
 * until then the honest path is: launch the app yourself (Android
 * Studio emulator or a device), expose its HTTP interface, and hand
 * FEA the base URL — parity then runs over plain HTTP vectors.
 */
export interface AppHarness {
  name: string;
  /** HTTP base URL of the running app, e.g. http://127.0.0.1:8080 */
  baseUrl: string;
  close(): Promise<void>;
}

/** You launch the app; FEA just needs its URL. */
export class ManualHarness implements AppHarness {
  readonly name = "manual";
  constructor(readonly baseUrl: string) {
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error(`ManualHarness needs an http(s) base URL, got: ${baseUrl}`);
    }
  }
  async close(): Promise<void> {}
}

async function commandExists(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: 10_000 }, (err) => {
      resolve(!err);
    });
    child.on("error", () => resolve(false));
  });
}

/** Are the Android platform tools present on this machine? */
export async function probeAndroidTools(): Promise<{ adb: boolean; emulator: boolean }> {
  const [adb, emulator] = await Promise.all([
    commandExists("adb", ["--version"]),
    commandExists("emulator", ["-version"])
  ]);
  return { adb, emulator };
}
