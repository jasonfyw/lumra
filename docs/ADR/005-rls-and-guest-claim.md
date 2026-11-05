# 005. RLS and guest claim security

Status: Accepted · Date: 2026-11-05 · Task: T02 (schema/RLS), T07 (claim flow)

## Context

Supabase exposes every table in `public` to browser clients over PostgREST, using the `anon` and
`authenticated` roles. By default Supabase grants those roles ALL privileges on new tables, so only
RLS stands between a browser and the data. Lumra keeps several kinds of data that a browser must
never touch: guest capabilities and quota counters, upload reservations, archive jobs, viewer access
sessions, analytics events, the billing ledger, Stripe exports, the job outbox and webhook dedupe
records (PRD §6.2, §8). The PRD access matrix also says creator access requires
`auth.uid() = owner_id`, and that a guest draft moves to its owner only with the guest capability
plus a verified session (FR-A03, FR-A04, §11 "Guest claims draft from another session").

## Decision

**Deny by default, in two layers.**

1. **Privileges.** Migration `20261105000300_rls_and_grants.sql` revokes all table, sequence and
   function privileges from `anon`/`authenticated` (and functions from `PUBLIC`). It also changes the
   default privileges in `public`, so tables added later stay unexposed until a migration grants
   access on purpose. `service_role` keeps full access and bypasses RLS. It is used only by trusted
   server and worker code.
2. **RLS enabled on every table.** If a grant is added by mistake, a table with no policy still
   returns nothing.

**Browser-readable (owner) tables. `authenticated` gets SELECT only:**

| Table              | Policy                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `profiles`         | `auth.uid() = user_id`; UPDATE limited to the `display_name` column (column-level grant)   |
| `billing_accounts` | `auth.uid() = user_id` (read-only; Stripe webhooks and the cap API write via service role) |
| `galleries`        | `auth.uid() = owner_id AND deleted_at IS NULL`                                             |
| `media`            | parent gallery owned by `auth.uid()` and not deleted; `media.deleted_at IS NULL`           |
| `media_variants`   | parent media/gallery as above                                                              |
| `plans`            | readable by `anon` and `authenticated` (pricing page)                                      |

Browser roles have no INSERT/UPDATE/DELETE on galleries or media. Every mutation goes through a
Next.js route handler. The handler authenticates the Supabase session on the server, runs the
`@lumra/domain` rules (state machines, quotas, access-version bumps) and writes with the service
role. This keeps the business logic in one place (CLAUDE.md) and stops a browser from setting
`status`, `slug`, `owner_id`, `access_version` or `password_hash` directly.

**Service-only (no grants, no policies):** `guest_sessions`, `upload_sessions`, `archive_jobs`,
`archive_parts`, `gallery_access_sessions`, `gallery_events`, `usage_ledger`, `billing_exports`,
`job_outbox`, `provider_webhook_events`. Analytics reach owners only as aggregates from
`GET /api/v1/galleries/{id}/analytics`.

**Guest ownership and claim:**

- `galleries_ownership` CHECK: before a claim, exactly one of `owner_id` / `guest_session_id` is
  set. A claim sets `owner_id` and `claimed_at` and may keep `guest_session_id` as provenance.
  `galleries_published_has_owner` means a guest draft cannot be published without an owner.
- Only `capability_hash` (SHA-256 of the 128-bit+ cookie secret) is stored, never the capability.
- The claim (T07) runs in a single service-role transaction:
  1. Lock the guest session by `capability_hash` from the HttpOnly cookie (`FOR UPDATE`).
  2. Require it to be unexpired and unclaimed, and the gallery's `guest_session_id` to match.
  3. Set `galleries.owner_id = <verified auth.uid()>, claimed_at = now()`.
  4. Set `guest_sessions.claimed_by_user_id/claimed_at`.

  A gallery ID alone is never enough.

- Guest quota is reserved with `public.reserve_guest_upload(guest_session_id, file_bytes)`. It is
  `SECURITY DEFINER`, executable only by `service_role`, and runs a single conditional `UPDATE`
  (≤20 files, ≤250,000,000 bytes, unexpired, unclaimed). Concurrent callers queue on the row lock
  and re-check the predicate, so 21 parallel calls give exactly 20 successes (tested). Table CHECKs
  repeat the limits as a backstop.

## Consequences

- Every new table needs explicit grants and policies in its migration. Without them it stays
  invisible to browsers, which is the safe failure.
- Owner dashboards may read with a user-scoped Supabase client. Writes always need a server
  endpoint, and each endpoint needs its own authorization test (CLAUDE.md).
- `packages/db/test-db/rls.test.ts` proves the isolation, the service-only lockdown and RLS
  coverage. `packages/db/src/schema.test.ts` statically checks that every table has RLS enabled.

## Alternatives considered

- **Owner-scoped INSERT/UPDATE policies for browsers:** more surface area. Column-level rules would
  have to block `status`/`slug`/`access_version` changes, and the domain logic would be duplicated
  in SQL.
- **A separate private schema for service tables:** also valid. Rejected for now because the Supabase
  CLI type generation and Drizzle mirror are simpler with one schema, and revoked grants plus RLS
  give the same guarantee.
