# Supabase

Schema, RLS policies and seed data for Lumra (T02). See [ADR-005](../../docs/ADR/005-rls-and-guest-claim.md)
for the security model and [ADR-007](../../docs/ADR/007-database-access-layer.md) for the migration and
query-layer approach.

## Layout

- `config.toml`: minimal local stack (Postgres 17, PostgREST, Auth with email OTP/magic link,
  local SMTP inbox). Storage, Realtime, Edge Functions, Studio and Analytics are disabled.
- `migrations/`: versioned SQL and the single source of truth. Forward-only in production; each PR
  notes its rollback/forward-fix plan.
  - `20261105000100_core_schema.sql`: enums, all PRD §8 tables, constraints, indexes,
    `updated_at` triggers, `plans` seeded from `RATE_CARD_V1`.
  - `20261105000200_auth_and_quota_functions.sql`: `handle_new_user` trigger on `auth.users`,
    `reserve_guest_upload()` (atomic guest quota, service role only).
  - `20261105000300_rls_and_grants.sql`: RLS on every table, owner read policies, service-only
    lockdown, default-privilege hardening.
  - `20261109000100_rate_card_versions_and_metering.sql` (T27): immutable `plan_rate_versions` (public
    read, v1 = PRD §9.2 proposed rate card), `plans` → current-version FK + projection trigger,
    service-only `storage_accrual_cursors`. See `docs/BILLING.md`.
  - `20261105001000_rate_limits_and_upload_tracking.sql` (T06/T10): `rate_limit_buckets` +
    `rate_limit_hit()`/`prune_rate_limit_buckets()` (service-only), `release_guest_upload()`,
    `upload_sessions.guest_session_id`, `media.checksum_sha256`. See `docs/UPLOADS.md`.
- `seed.sql`: synthetic local fixtures only (a demo creator, a draft and a guest draft).
- DB tests live in `packages/db/test-db/` (Vitest + postgres.js against the local stack); route-level
  upload/guest tests in `apps/web/test-db/`. `pnpm test:db` runs both.

## Commands

Run from the repo root (Docker required):

```sh
pnpm dlx supabase@latest start --workdir infra      # local stack; DB on 127.0.0.1:54322
pnpm dlx supabase@latest db reset --workdir infra   # re-apply migrations + seed.sql
pnpm test:db                                        # RLS / constraint / quota-concurrency tests
pnpm dlx supabase@latest stop --workdir infra
```

`pnpm test:db` targets `postgresql://postgres:postgres@127.0.0.1:54322/postgres` by default. Set
`DATABASE_URL` to point it elsewhere. The default `pnpm test` does not need a database.

OTP and magic-link emails sent by local Auth appear at <http://127.0.0.1:54324>.

If `public.ecr.aws` is unreachable, pull images from Docker Hub instead:
`SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io pnpm dlx supabase@latest start --workdir infra`.

## Adding a migration

1. `pnpm dlx supabase@latest migration new <name> --workdir infra` and write forward SQL.
2. New tables: `enable row level security`, plus explicit grants and policies (default privileges
   expose nothing to `anon`/`authenticated`).
3. Mirror the change in `packages/db/src/schema.ts` and, if needed, `packages/db/src/enums.ts`.
   `pnpm test` fails on drift.
4. Add or extend tests in `packages/db/test-db/` and run `pnpm test:db`.
5. Put the rollback/forward-fix note in the PR description.
