# Repository Guidelines

## Project Structure & Module Organization

Ventriloquist is a pnpm workspace with three TypeScript packages:

- `worker/` - Cloudflare Worker MCP facade: `src/mcp/`, `src/backends/`, `src/velocity/`, `src/storage/`, `src/cron/`, `migrations/`, `test/`
- `signer/` - Fastify signer gateway (Puppeteer), with `src/` and `test/`
- `vps-agent/` - Playwright posting worker, with `src/` and `test/`

Shared assets live in `scripts/` (`smoke.mjs`, `seed-cohort.mjs`) and `docs/` (`decisions.md`, `runbook.md`). The technical spec is `ventriloquist-tiktok-mcp-spec.md`.

## Build, Test, and Development Commands

Run all commands from the repository root:

- `pnpm install` - install workspace dependencies (Node >= 22).
- `pnpm migrate:local` - apply D1 migrations to the local database.
- `pnpm dev` - run the Worker facade on `:8787`; `pnpm signer:dev` runs the signer.
- `pnpm test` - run every package's Vitest suite.
- `pnpm typecheck` - run `tsc --noEmit` across the workspace.
- `pnpm smoke` - boot mocks and drive the real MCP endpoint end to end.

Scope a package with `pnpm --filter @ventriloquist/worker run test:watch`.

## Coding Style & Naming Conventions

Use ESM TypeScript, two-space indentation, double quotes, semicolons, and `camelCase` for values with `PascalCase` for types. Tool files follow existing names such as `worker/src/backends/providers/creativeCenter.ts`; MCP tool names are `tt_*` and must declare a risk tier. Strict settings come from `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`). No linter or formatter is configured, so match surrounding code and rely on `pnpm typecheck`.

## Testing Guidelines

Vitest is configured per package; tests belong in `<package>/test/**/*.test.ts` and are named `<subject>.test.ts` (for example, `velocity-math.test.ts`). Use `describe("<unit>")` and `it("<observable behavior>")`. Add focused tests for new routing, velocity, posting, or validation logic, then run `pnpm test` and `pnpm typecheck`. Use `pnpm smoke` for integration changes.

## Commit & Pull Request Guidelines

Follow Conventional Commits with an optional scope: `fix(smoke): resolve workspace-local binaries`, `docs: update runbook`, `chore: scaffold pnpm workspace`. Keep subjects imperative; explain the reason in the body. Pull requests should state what changed and why, list verification commands, link the relevant spec section or issue, and call out risk-tier, binding, or secret changes.

## Configuration & Security

Copy `.env.example` values into local environment files or `wrangler` secrets. Never commit tokens, posting sessions, or `.dev.vars`. Use `MOCK=1` for offline development; live signer and posting paths require Chromium, vendor keys, and a real session. Declare Worker bindings in `worker/wrangler.toml`.
