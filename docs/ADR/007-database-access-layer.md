# 007. Database access layer

Status: Accepted · Date: 2026-11-05 · Task: T02

## Context

The Next.js app and the Cloudflare Workers both read and write Supabase Postgres. The schema relies
on Postgres features that ORMs model poorly: RLS policies, column-level grants, partial and
collated indexes, CHECK constraints, triggers (`updated_at`, `handle_new_user`, the append-only
ledger) and `SECURITY DEFINER` functions (`reserve_guest_upload`). We still want typed queries in
TypeScript strict mode.

## Decision

- **SQL-first migrations.** `infra/supabase/migrations/<timestamp>_<name>.sql` is the only source of
  truth. The Supabase CLI applies the files (`supabase db reset` locally, `supabase db push` for
  hosted projects). They are forward-only in production, and every PR that changes the DB carries a
  rollback/forward-fix note.
- **Drizzle ORM as a typed query builder only.** `packages/db/src/schema.ts` mirrors the tables and
  enums by hand. drizzle-kit is not used and Drizzle never generates or applies migrations.
  `packages/db/src/schema.test.ts` fails CI if the mirror drifts from the SQL (table set, column
  names, enum values).
- **Enum values are defined once in TypeScript.** Status sets that belong to the API or domain
  (`MEDIA_STATUSES`, `GALLERY_STATUSES`, `ARCHIVE_STATUSES`) are imported from
  `@lumra/contracts`/`@lumra/domain`. The database-only sets (upload/billing/export/webhook statuses,
  event types, usage metrics) live in `packages/db/src/enums.ts`. The same drift test checks each one
  against `create type ... as enum`.
- **Driver:** `postgres` (postgres.js) through `createDb(databaseUrl)`, with `prepare: false` by
  default so it works behind Supabase's transaction pooler. `createDb` is **server-only**: the
  connection bypasses RLS. Browser code uses the Supabase JS client with the publishable/anon key and
  is bound by ADR-005.
- **Number types:** BIGINT columns (bytes, micro-USD, byte-seconds) map to JS `number`
  (`mode: 'number'`). All values stay below 2^53.
- **`plans.id` is the `PlanId` text (`'free' | 'pro'`) rather than a UUID.** `@lumra/billing` and
  `profiles.plan_id` join on it directly, and the columns copy `PlanRates` from
  `packages/config/src/rate-card.ts` one-to-one in micro-USD. This is a deliberate exception to the
  "UUID PKs" convention (PRD §8). The PRD's `monthly_fee_cents` is not stored: Stripe prices are
  configured in Stripe, and internal money is micro-USD only. A new rate card version updates the
  row in a migration and bumps `rate_version`, which every `usage_ledger` row records.

## Consequences

- A schema change means editing the SQL migration first, then `schema.ts`. The drift test enforces
  the order.
- CHECKs, partial indexes, triggers and policies are not visible in Drizzle types. Application code
  must expect constraint errors (SQLSTATE 23514/23505) and map them to API errors.
- DB integration tests (`pnpm test:db`) need the local Supabase stack (Docker). The default
  `pnpm test` stays database-free.

## Alternatives considered

- **Drizzle-generated migrations (drizzle-kit):** cannot express RLS, grants and triggers cleanly,
  and would compete with the Supabase CLI migration history.
- **Prisma:** heavier runtime, weaker Workers story, and the same migration-ownership conflict.
- **supabase-js / PostgREST for server access:** cannot run multi-statement transactions such as
  the claim, the outbox or ledger writes.
- **Kysely + generated types:** viable, but Drizzle's table objects double as the typed mirror the
  drift test checks.
