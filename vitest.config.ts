import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => resolve(root, "packages", name, "src", "index.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@fea/spec": pkg("spec"),
      "@fea/sandbox": pkg("sandbox"),
      "@fea/readers": pkg("readers"),
      "@fea/cleanroom": pkg("cleanroom"),
      "@fea/oracle": pkg("oracle"),
      "@fea/mcp": pkg("mcp")
    }
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"]
  }
});
