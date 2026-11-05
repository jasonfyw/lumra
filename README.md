# Lumra

Minimal, premium-feeling photo delivery: create a gallery without an account, upload, publish, share one link.

- Product spec: [`docs/PRD.md`](docs/PRD.md)
- Implementation plan and task breakdown: [`docs/PLAN.md`](docs/PLAN.md)
- Architecture decisions: [`docs/ADR`](docs/ADR)

## Layout

```
apps/web            Next.js App Router (Vercel) — UI, API route handlers, auth, Stripe
apps/media-gateway  Cloudflare Worker — authorizes and streams private R2 media
apps/worker         Cloudflare Worker — queue consumers, cron reconcilers, metering export
packages/config     env schemas, product limits, rate card
packages/contracts  Zod API / queue / media-token contracts
packages/domain     pure business logic (state machines, quotas, layout)
packages/db         database access layer
packages/billing    rating, ledger, Stripe adapter
packages/media      storage keys, R2 adapter, file sniffing
packages/observability  structured logging, redaction, request IDs, Sentry scrubbing
packages/tokens     media-token signing/verification, gallery access-state store (ADR-001)
packages/ui         design tokens and shared components
infra/              Cloudflare, Supabase and Vercel configuration
tests/              e2e (Playwright), security, performance
```

## Getting started

Requires Node 22+ and pnpm 10 (`corepack enable`).

```sh
pnpm install
cp apps/web/.env.example apps/web/.env.local
pnpm dev                 # all apps via Turborepo
pnpm lint typecheck test # what CI runs (plus build and format:check)
pnpm e2e                 # Playwright smoke tests (starts the web app)
```
