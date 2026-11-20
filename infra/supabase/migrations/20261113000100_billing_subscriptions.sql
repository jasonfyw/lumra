-- T28–T30, T33: Stripe subscription entitlements, delivery safety cutoff, webhook bookkeeping.
--
-- Forward-only in production. Everything is additive: new nullable/defaulted columns and
-- constraints that every existing row already satisfies (all accounts are `free` before this
-- migration, with no pause and no subscription). Rollback / forward-fix:
--   alter table public.billing_accounts
--     drop constraint billing_accounts_status_timestamps,
--     drop constraint billing_accounts_delivery_pause_pair,
--     drop column delivery_paused_at, drop column delivery_paused_reason,
--     drop column subscription_event_at, drop column cancel_at_period_end,
--     drop column stripe_subscription_status;
--   drop index public.billing_accounts_paused_idx;
--   drop index public.billing_accounts_past_due_idx;
--   alter table public.provider_webhook_events
--     drop column account_id, drop column last_error, drop column attempt_count,
--     drop column object_id;
--   drop function public.enqueue_owner_access_sync(uuid, text);
--   drop function public.enqueue_account_email(uuid, text, text, jsonb, text);
-- Rolling back while subscriptions exist loses the event-ordering guard and the pause flag; the
-- next Stripe webhook / delivery batch re-derives both, so a forward-fix is always preferable.

-- ---------------------------------------------------------------------------------------------
-- billing_accounts: entitlement state from confirmed Stripe webhooks (@lumra/billing
-- applySubscriptionSnapshot) and the delivery safety cutoff (deliveryPauseFor).
-- ---------------------------------------------------------------------------------------------

alter table public.billing_accounts
  -- Raw `subscription.status` as last confirmed by a webhook (diagnostics; `status` is the rule).
  add column stripe_subscription_status text
    check (stripe_subscription_status is null or char_length(stripe_subscription_status) <= 40),
  -- Pro canceled in the portal but active until the period end.
  add column cancel_at_period_end boolean not null default false,
  -- `event.created` of the last applied subscription event: older deliveries are ignored.
  add column subscription_event_at timestamptz,
  -- Delivery safety cutoff (PRD §9.4): Free monthly delivery cap or Pro spending cap reached.
  -- Mirrored into the gateway's KV access state (`deliverySuspended`) for every gallery.
  add column delivery_paused_reason text
    check (delivery_paused_reason is null or delivery_paused_reason in ('free_delivery_cap', 'spend_cap')),
  add column delivery_paused_at timestamptz,
  add constraint billing_accounts_delivery_pause_pair
    check ((delivery_paused_reason is null) = (delivery_paused_at is null)),
  -- The past-due policy hangs off these timestamps (deriveBillingRestrictions fails closed
  -- without them); make the invariant structural.
  add constraint billing_accounts_status_timestamps check (
    (status <> 'past_due' or past_due_since is not null)
    and (status <> 'restricted' or restricted_since is not null or past_due_since is not null)
    and (status <> 'canceled' or canceled_at is not null)
  );

-- Hourly sweep (apps/worker billing maintenance): past_due → restricted, canceled → free,
-- and paused accounts whose allowance is back.
create index billing_accounts_past_due_idx on public.billing_accounts (status)
  where status in ('past_due', 'canceled');
create index billing_accounts_paused_idx on public.billing_accounts (delivery_paused_at)
  where delivery_paused_reason is not null;

-- ---------------------------------------------------------------------------------------------
-- provider_webhook_events: dedupe + outcome per Stripe event id (G-06). The payload itself is
-- not stored (it carries customer email/address); Stripe keeps it for 30 days.
-- ---------------------------------------------------------------------------------------------

alter table public.provider_webhook_events
  -- The Stripe object the event is about (sub_…, cs_…, in_…).
  add column object_id text check (object_id is null or char_length(object_id) <= 255),
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  -- Error class only (never a message that could echo payload data).
  add column last_error text check (last_error is null or char_length(last_error) <= 200),
  add column account_id uuid references public.billing_accounts (user_id) on delete set null;

-- RLS: billing_accounts keeps "owner may SELECT, writes service-only" (the table-level grant
-- covers the new columns); provider_webhook_events stays service-only.

-- ---------------------------------------------------------------------------------------------
-- Outbox helpers shared by the web app (webhooks, cap changes) and the worker (delivery cutoff,
-- hourly sweep), so both enqueue identical rows inside their own transaction. Service-only.
-- ---------------------------------------------------------------------------------------------

-- Re-sync the gateway KV access state of every published gallery of `owner` (ADR-001): billing
-- status, plan or delivery pause changed. Returns the number of rows enqueued.
create function public.enqueue_owner_access_sync(owner uuid, trace text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  with keys as (
    select g.id, 'gallery.access_changed:' || g.id || ':' || gen_random_uuid() as dedupe_key
    from public.galleries g
    where g.owner_id = owner and g.deleted_at is null and g.status = 'published'
  )
  insert into public.job_outbox (event_name, aggregate_id, payload, dedupe_key)
  select 'gallery.access_changed', k.id,
         jsonb_build_object('type', 'gallery.access_changed', 'galleryId', k.id,
                            'traceId', coalesce(trace, ''), 'dedupeKey', k.dedupe_key),
         k.dedupe_key
  from keys k;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Account email (`email.send`, @lumra/contracts EMAIL_TEMPLATES). `dedupe` makes the notice
-- once-only (e.g. one alert per account/period/threshold); returns false for a duplicate.
create function public.enqueue_account_email(
  account uuid, template text, dedupe text, data jsonb, trace text
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  inserted uuid;
begin
  insert into public.job_outbox (event_name, aggregate_id, payload, dedupe_key)
  values ('email.send', account,
          jsonb_build_object('type', 'email.send', 'accountId', account, 'template', template,
                             'data', coalesce(data, '{}'::jsonb), 'traceId', coalesce(trace, ''),
                             'dedupeKey', dedupe),
          dedupe)
  on conflict (dedupe_key) do nothing
  returning id into inserted;
  return inserted is not null;
end;
$$;

revoke all on function public.enqueue_owner_access_sync(uuid, text) from public, anon, authenticated;
revoke all on function public.enqueue_account_email(uuid, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_owner_access_sync(uuid, text) to service_role;
grant execute on function public.enqueue_account_email(uuid, text, text, jsonb, text) to service_role;
