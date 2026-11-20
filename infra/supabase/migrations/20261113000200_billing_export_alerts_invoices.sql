-- T31–T32: Stripe meter export cursors + stored payloads, invoice history, reconciliation,
-- spend-cap alerts.
--
-- Forward-only in production. Additive: new tables and nullable columns on the (so far unused)
-- billing_exports table. Rollback / forward-fix:
--   drop table public.billing_reconciliations;
--   drop table public.billing_invoices;
--   drop table public.billing_alerts;
--   drop table public.billing_meter_cursors;
--   drop table public.billing_periods;
--   alter table public.billing_exports
--     drop column last_error, drop column sent_at, drop column payload, drop column meter_value,
--     drop column window_end, drop column period_start, drop column metric, drop column event_name;
--   drop index public.billing_exports_unsent_idx;
-- Dropping the cursors after events were sent would re-export from zero: Stripe dedupes a
-- resent identifier only for ~24 h, so never drop them in production — forward-fix instead.

-- ---------------------------------------------------------------------------------------------
-- Meter export (ADR-004 amendment, @lumra/billing buildMeterEvents). Each run stores the built
-- events (one billing_exports row per event; idempotency_key = Stripe `identifier`) and the new
-- cumulative cursors in ONE transaction before sending; retries resend the stored payload.
-- ---------------------------------------------------------------------------------------------

-- Paid subscription periods, recorded by the webhook whenever a confirmed subscription sets one.
-- Only usage stamped with one of these periods is ever exported to Stripe: Free usage (calendar
-- periods) can never reach a meter, even after an upgrade mid-month.
create table public.billing_periods (
  account_id uuid not null references public.billing_accounts (user_id) on delete restrict,
  period_start timestamptz not null,
  period_end timestamptz not null,
  stripe_subscription_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_periods_pkey primary key (account_id, period_start),
  constraint billing_periods_order check (period_end > period_start)
);

create index billing_periods_end_idx on public.billing_periods (period_end);

create trigger billing_periods_set_updated_at before update on public.billing_periods
  for each row execute function public.set_updated_at();

create table public.billing_meter_cursors (
  account_id uuid not null references public.billing_accounts (user_id) on delete restrict,
  metric public.usage_metric not null,
  period_start timestamptz not null,
  -- Cumulative overage meter units (MB / MB-month) already recorded for export.
  exported_units bigint not null check (exported_units >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_meter_cursors_pkey primary key (account_id, metric, period_start)
);

create trigger billing_meter_cursors_set_updated_at before update on public.billing_meter_cursors
  for each row execute function public.set_updated_at();

alter table public.billing_exports
  add column event_name text check (event_name is null or char_length(event_name) <= 100),
  add column metric public.usage_metric,
  add column period_start timestamptz,
  add column window_end timestamptz,
  add column meter_value bigint check (meter_value is null or meter_value > 0),
  -- The exact `POST /v1/billing/meter_events` body (customer id, value, timestamp): resent as is.
  add column payload jsonb,
  add column sent_at timestamptz,
  add column last_error text check (last_error is null or char_length(last_error) <= 200);

create index billing_exports_unsent_idx on public.billing_exports (created_at)
  where status <> 'sent';

-- ---------------------------------------------------------------------------------------------
-- Invoices (T31): written from invoice.* webhooks, listed on /account (owner read).
-- ---------------------------------------------------------------------------------------------

create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.billing_accounts (user_id) on delete cascade,
  stripe_invoice_id text not null unique check (char_length(stripe_invoice_id) <= 255),
  number text check (number is null or char_length(number) <= 100),
  status text not null check (status in ('draft', 'open', 'paid', 'uncollectible', 'void')),
  billing_reason text check (billing_reason is null or char_length(billing_reason) <= 60),
  currency text not null check (char_length(currency) = 3),
  subtotal_cents bigint not null,
  total_cents bigint not null,
  amount_due_cents bigint not null check (amount_due_cents >= 0),
  amount_paid_cents bigint not null check (amount_paid_cents >= 0),
  period_start timestamptz,
  period_end timestamptz,
  -- Stripe-hosted pages; shown only to the owner, never logged.
  hosted_invoice_url text check (hosted_invoice_url is null or hosted_invoice_url ~ '^https://'),
  invoice_pdf text check (invoice_pdf is null or invoice_pdf ~ '^https://'),
  stripe_created_at timestamptz not null,
  -- `event.created` of the last applied invoice event (older deliveries are ignored).
  stripe_event_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index billing_invoices_account_created_idx
  on public.billing_invoices (account_id, stripe_created_at desc);

create trigger billing_invoices_set_updated_at before update on public.billing_invoices
  for each row execute function public.set_updated_at();

-- Internal vs Stripe comparison per finalized invoice (PRD §9.5 reconciliation report).
create table public.billing_reconciliations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.billing_accounts (user_id) on delete cascade,
  stripe_invoice_id text not null unique,
  usage_period_start timestamptz,
  expected_cents bigint not null,
  stripe_cents bigint not null,
  drift_bps integer not null check (drift_bps >= 0),
  flagged boolean not null,
  exceeds_cap_tolerance boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index billing_reconciliations_flagged_idx on public.billing_reconciliations (created_at)
  where flagged or exceeds_cap_tolerance;

create trigger billing_reconciliations_set_updated_at before update on public.billing_reconciliations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Spend-cap alerts (T32): once per (account, period, threshold); owner read for the banner.
-- ---------------------------------------------------------------------------------------------

create table public.billing_alerts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.billing_accounts (user_id) on delete cascade,
  period_start timestamptz not null,
  threshold_pct smallint not null check (threshold_pct between 1 and 100),
  spend_micro_usd bigint not null check (spend_micro_usd >= 0),
  cap_micro_usd bigint not null check (cap_micro_usd >= 0),
  created_at timestamptz not null default now(),
  constraint billing_alerts_once unique (account_id, period_start, threshold_pct)
);

-- ---------------------------------------------------------------------------------------------
-- RLS: invoices and alerts are owner-readable; periods, cursors and reconciliations are
-- service-only.
-- ---------------------------------------------------------------------------------------------

alter table public.billing_periods enable row level security;
alter table public.billing_meter_cursors enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_reconciliations enable row level security;
alter table public.billing_alerts enable row level security;

revoke all on public.billing_periods, public.billing_meter_cursors, public.billing_invoices,
  public.billing_reconciliations, public.billing_alerts from anon, authenticated;
grant all on public.billing_periods, public.billing_meter_cursors, public.billing_invoices,
  public.billing_reconciliations, public.billing_alerts to service_role;

grant select on public.billing_invoices, public.billing_alerts to authenticated;

create policy billing_invoices_owner_read on public.billing_invoices
  for select to authenticated
  using (account_id = (select auth.uid()));

create policy billing_alerts_owner_read on public.billing_alerts
  for select to authenticated
  using (account_id = (select auth.uid()));
