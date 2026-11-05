-- T02: row-level security and grants (ADR-005).
--
-- Model:
--   * RLS is enabled on every table in public. service_role bypasses RLS and is the only role that
--     writes; it is used exclusively by trusted server/worker code.
--   * Browser roles (anon, authenticated) get NO table privileges by default. Supabase's default
--     grants (ALL to anon/authenticated on new public tables) are revoked here and for the future.
--   * authenticated may SELECT its own owner-facing rows (profiles, billing_accounts, galleries,
--     media, media_variants) and UPDATE only profiles.display_name. All other mutations go through
--     server route handlers that authorise with @lumra/domain and write with the service role.
--   * plans is publicly readable (pricing page). Everything else is service-only.

-- ---------------------------------------------------------------------------------------------
-- Lock down defaults: future tables/functions/sequences in public are not exposed automatically.
-- ---------------------------------------------------------------------------------------------

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.reserve_guest_upload(uuid, bigint) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Enable RLS everywhere (deny by default; tables without policies are invisible to browser roles
-- even if a grant is added by mistake).
-- ---------------------------------------------------------------------------------------------

alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.billing_accounts enable row level security;
alter table public.guest_sessions enable row level security;
alter table public.galleries enable row level security;
alter table public.media enable row level security;
alter table public.media_variants enable row level security;
alter table public.upload_sessions enable row level security;
alter table public.archive_jobs enable row level security;
alter table public.archive_parts enable row level security;
alter table public.gallery_access_sessions enable row level security;
alter table public.gallery_events enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.billing_exports enable row level security;
alter table public.job_outbox enable row level security;
alter table public.provider_webhook_events enable row level security;

-- ---------------------------------------------------------------------------------------------
-- plans: public read
-- ---------------------------------------------------------------------------------------------

grant select on public.plans to anon, authenticated;

create policy plans_public_read on public.plans
  for select to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------------------------
-- profiles: owner read; owner may change display_name only (column-level grant)
-- ---------------------------------------------------------------------------------------------

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy profiles_owner_read on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy profiles_owner_update on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------------------------
-- billing_accounts: owner read only (writes are service-only: Stripe webhooks, cap changes via API)
-- ---------------------------------------------------------------------------------------------

grant select on public.billing_accounts to authenticated;

create policy billing_accounts_owner_read on public.billing_accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------------------------
-- galleries / media / media_variants: owner read of non-deleted rows
-- ---------------------------------------------------------------------------------------------

grant select on public.galleries to authenticated;

create policy galleries_owner_read on public.galleries
  for select to authenticated
  using ((select auth.uid()) = owner_id and deleted_at is null);

grant select on public.media to authenticated;

create policy media_owner_read on public.media
  for select to authenticated
  using (
    deleted_at is null
    and exists (
      select 1
      from public.galleries g
      where g.id = media.gallery_id
        and g.owner_id = (select auth.uid())
        and g.deleted_at is null
    )
  );

grant select on public.media_variants to authenticated;

create policy media_variants_owner_read on public.media_variants
  for select to authenticated
  using (
    exists (
      select 1
      from public.media m
      join public.galleries g on g.id = m.gallery_id
      where m.id = media_variants.media_id
        and m.deleted_at is null
        and g.owner_id = (select auth.uid())
        and g.deleted_at is null
    )
  );

-- Service-only (no grants, no policies): guest_sessions, upload_sessions, archive_jobs,
-- archive_parts, gallery_access_sessions, gallery_events, usage_ledger, billing_exports,
-- job_outbox, provider_webhook_events.
