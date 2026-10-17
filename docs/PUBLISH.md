# Publishing FEA to npm

Target: **`fea-agents`** — the name is verified free on npm (`fea` itself is
taken, so the binary stays `fea` while the package is `fea-agents`).

## What is ready

- Every `packages/*` package has publish metadata (description, license,
  author, repository, `files: ["dist"]`).
- `apps/cli` is the published package: name `fea-agents`, `bin.fea`,
  `prepack` copies the root README + LICENSE in.

## Publish order

The workspace packages depend on each other (`@fea/mcp` → `@fea/policy`,
`@fea/readers`, …), so publish **dependencies first**, then the CLI:

```
spec → sandbox → cleanroom → policy → readers → oracle → mcp → fea-agents (apps/cli)
```

## Steps (run from your machine with npm login)

npm needs *your* login — the publish can't be done from the build VM.

1. `npm login` (account that owns the `fea-agents` name)
2. From `~/workspace/fea` (exact folder):
   ```bash
   pnpm verify                                   # must be ALL GREEN
   for p in spec sandbox cleanroom policy readers oracle mcp; do
     (cd packages/$p && npm publish --access public)
   done
   cd apps/cli && npm publish --access public
   ```
3. Verify: on any machine, `npm i -g fea-agents` then `fea --version` → `0.4.0`.

## After publishing

- `pnpm -r exec npm dist-tag` to confirm all 8 packages show `latest`.
- The GitHub repo README already documents `npm i -g fea-agents` as the
  install path; flip the "from source" instructions to secondary once the
  packages are live.
- Never publish from a dirty tree: `git status` must be clean and the
  commit pushed first.

## Why not bundled

The CLI is published as source with its `@fea/*` dependencies as real
npm packages (not bundled) so agents and contributors can depend on
`@fea/oracle` or `@fea/spec` directly. If a zero-dependency single file
is ever needed, add a bundling step (esbuild) — not done in v0.4.
