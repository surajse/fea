#!/usr/bin/env node
// pnpm verify — typecheck + lint + tests + build. Must be green before any commit.
import { execSync } from "node:child_process";

const steps = [
  ["typecheck", "pnpm typecheck"],
  ["lint", "pnpm lint"],
  ["test", "pnpm test"],
  ["build", "pnpm build"]
];

for (const [name, cmd] of steps) {
  console.log(`\n=== verify: ${name} ===`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch {
    console.error(`\nverify FAILED at step: ${name}`);
    process.exit(1);
  }
}
console.log("\nverify: ALL GREEN");
