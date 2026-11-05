# Lumra — agent working agreement

Read `docs/PRD.md` (spec), `docs/PLAN.md` (task breakdown, T01–T40) and relevant `docs/ADR/*` before starting a task.

## Rules (PRD §13–14)

- One task = one bounded PR with tests and docs. Reference the task ID (e.g. `T10`) in the branch/PR title.
- Change contracts (`packages/contracts`) and schema (`infra/supabase/migrations`) first, then implementations.
- Business logic lives in `packages/domain` / `packages/billing` — never duplicated between web and Workers.
- Every state-changing endpoint has an authorization test. Every metered action has ledger coverage.
- Every DB change includes a migration plus a rollback/forward-fix note in the PR.
- Never send media bytes through Vercel route handlers. Never make R2 buckets public. No video in v1.
- Money is integer micro-USD. Bytes are `BIGINT`/`number` integers, decimal GB.
- Don't add scope not in the PRD; record conflicts as an ADR plus a regression test.
- Don't switch framework/storage/auth stack without a PRD change.

## Commands

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm format            # prettier
pnpm e2e               # Playwright (tests/e2e); set PLAYWRIGHT_CHROMIUM_EXECUTABLE to reuse a preinstalled Chromium
pnpm --filter @lumra/web dev
```

## Conventions

- TypeScript strict; Zod schemas are the source of truth and types are inferred from them.
- Internal packages export TS source (`./src/index.ts`); no build step.
- Shared packages must run in Workers: Web APIs only, no Node built-ins unless the file is server-only.
- API responses use `{ data, error, requestId }` (see `apps/web/src/lib/api.ts`).
- Logs are structured JSON; never log tokens, passwords, signed URLs, full IPs or unnecessary filenames.
