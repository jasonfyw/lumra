-- ADR-008: remove delivery (served bytes) from Lumra's pricing. Delivery is no longer tracked,
-- capped or charged on any plan; storage is the only metered quantity. Pricing after this
-- migration: Free = 2 active galleries + 1 GB storage hard cap; Pro = $2/month + 20 GB-month
-- included + $0.10/GB-month storage overage, $10 default spending cap (storage overage only).
--
-- What it does (one transaction):
--   1. Re-syncs the gateway KV state of every account whose galleries were paused by the
--      delivery cutoff (the pause no longer exists), then drops the pause columns.
--   2. Drops the delivery columns from `plans` and `plan_rate_versions`. The rate version is NOT
--      bumped: no storage or base-fee rate changes, and delivery was never billed, so storage
--      usage rated under v1 stays reproducible. The immutability guard and the plan projection
--      trigger are redefined without the dropped columns (no trigger is disabled); v1 notes are
--      updated (the guard permits notes changes).
--   3. Deletes `delivery_bytes` usage rows (never billed) under a temporary, flag-gated bypass of the
--      append-only guard, deletes delivery meter cursors, retires unsent delivery meter exports
--      (failed, never resent) and keeps sent ones for audit with `metric` cleared.
--   4. Recreates `usage_metric` with only 'storage_byte_seconds'.
--   5. Drops queued `delivery_paused` emails (the template no longer exists).
--
-- Forward-only in production. Rollback / forward-fix (schema only; deleted delivery ledger rows,
-- cursors and pause flags are not restored — they were never billed):
--   alter type public.usage_metric add value 'delivery_bytes';
--   alter table public.usage_ledger drop constraint usage_ledger_metric_unit,
--     add constraint usage_ledger_metric_unit check (
--       (metric = 'storage_byte_seconds' and unit = 'byte_seconds')
--       or (metric = 'delivery_bytes' and unit = 'bytes'));
--   alter table public.plans
--     add column max_delivery_bytes_per_month bigint,
--     add column included_delivery_gb integer not null default 0,
--     add column delivery_overage_micro_usd_per_gb bigint;
--   alter table public.plan_rate_versions (same three columns), then
--     update v1 rows: free (3000000000, 0, null), pro (null, 5, 30000) — requires restoring the
--     guard/projection functions from 20261109000100 *after* the update;
--   alter table public.billing_accounts
--     add column delivery_paused_reason text check (delivery_paused_reason is null
--       or delivery_paused_reason in ('free_delivery_cap', 'spend_cap')),
--     add column delivery_paused_at timestamptz,
--     add constraint billing_accounts_delivery_pause_pair
--       check ((delivery_paused_reason is null) = (delivery_paused_at is null));
-- …and redeploy the previous worker/gateway/web. A forward-fix (new migration) is preferable.

-- ---------------------------------------------------------------------------------------------
-- 1. Delivery cutoff (billing_accounts.delivery_paused_*)
-- ---------------------------------------------------------------------------------------------

-- Paused accounts have `deliverySuspended: true` in KV only because of the pause: re-sync them
-- (the worker re-derives the flag from billing status alone).
select public.enqueue_owner_access_sync(user_id, 'adr-008:remove-delivery-pause')
from public.billing_accounts
where delivery_paused_reason is not null;

drop index if exists public.billing_accounts_paused_idx;

alter table public.billing_accounts
  drop constraint billing_accounts_delivery_pause_pair,
  drop column delivery_paused_reason,
  drop column delivery_paused_at;

-- ---------------------------------------------------------------------------------------------
-- 2. Rate card: drop delivery columns
-- ---------------------------------------------------------------------------------------------

create or replace function public.plan_rate_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'plan_rate_versions is immutable; add a new rate_version instead'
      using errcode = 'restrict_violation';
  end if;
  if (new.plan_id, new.rate_version, new.monthly_fee_micro_usd, new.max_active_galleries,
      new.max_storage_bytes, new.included_storage_gb_month,
      new.storage_overage_micro_usd_per_gb_month, new.default_overage_cap_micro_usd,
      new.branding_visible, new.created_at)
     is distinct from
     (old.plan_id, old.rate_version, old.monthly_fee_micro_usd, old.max_active_galleries,
      old.max_storage_bytes, old.included_storage_gb_month,
      old.storage_overage_micro_usd_per_gb_month, old.default_overage_cap_micro_usd,
      old.branding_visible, old.created_at) then
    raise exception 'plan_rate_versions rates are immutable; add a new rate_version instead'
      using errcode = 'restrict_violation';
  end if;
  if old.decision = 'confirmed' and new.decision <> 'confirmed' then
    raise exception 'a confirmed rate version cannot return to proposed'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.plans_apply_rate_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v public.plan_rate_versions%rowtype;
begin
  select * into v
  from public.plan_rate_versions
  where plan_id = new.id and rate_version = new.rate_version;
  if not found then
    -- A brand-new plan id: the FK check reports the missing version.
    return new;
  end if;
  new.monthly_fee_micro_usd := v.monthly_fee_micro_usd;
  new.max_active_galleries := v.max_active_galleries;
  new.max_storage_bytes := v.max_storage_bytes;
  new.included_storage_gb_month := v.included_storage_gb_month;
  new.storage_overage_micro_usd_per_gb_month := v.storage_overage_micro_usd_per_gb_month;
  new.default_overage_cap_micro_usd := v.default_overage_cap_micro_usd;
  new.branding_visible := v.branding_visible;
  return new;
end;
$$;

alter table public.plan_rate_versions
  drop column max_delivery_bytes_per_month,
  drop column included_delivery_gb,
  drop column delivery_overage_micro_usd_per_gb;

alter table public.plans
  drop column max_delivery_bytes_per_month,
  drop column included_delivery_gb,
  drop column delivery_overage_micro_usd_per_gb;

update public.plan_rate_versions
set notes = case plan_id
  when 'free' then 'PRD §9.2 launch rate card (ADR-008: storage only). Proposed: 2 active '
                   'galleries, 1 GB storage hard cap.'
  else 'PRD §9.2 launch rate card (ADR-008: storage only). Confirmed: $2.00/month base and '
       '20 GB-month included storage. Proposed: $0.10/GB-month overage, $10 default overage cap.'
end
where rate_version = 1;

-- ---------------------------------------------------------------------------------------------
-- 3. Delivery usage, meter cursors and exports
-- ---------------------------------------------------------------------------------------------

-- `usage_ledger` is append-only by trigger. Deleting the never-billed delivery rows is the one
-- sanctioned exception: a flag-gated bypass, set only around the delete; the original guard is
-- restored right after.
create or replace function public.usage_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and old.metric::text = 'delivery_bytes'
     and current_setting('lumra.adr008_purge_delivery', true) = 'on' then
    return old;
  end if;
  raise exception 'usage_ledger is append-only; insert a compensating entry instead'
    using errcode = 'restrict_violation';
end;
$$;

select set_config('lumra.adr008_purge_delivery', 'on', false);
delete from public.usage_ledger where metric::text = 'delivery_bytes';
select set_config('lumra.adr008_purge_delivery', 'off', false);

create or replace function public.usage_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'usage_ledger is append-only; insert a compensating entry instead'
    using errcode = 'restrict_violation';
end;
$$;

delete from public.billing_meter_cursors where metric::text = 'delivery_bytes';

-- Unsent delivery meter events must never reach Stripe: fail them permanently (the exporter
-- only retries rows below its attempt limit).
update public.billing_exports
set status = 'failed', last_error = 'retired: delivery billing removed (ADR-008)',
    attempt_count = attempt_count + 1000
where metric::text = 'delivery_bytes' and status <> 'sent';

-- ---------------------------------------------------------------------------------------------
-- 4. usage_metric enum without 'delivery_bytes'
-- ---------------------------------------------------------------------------------------------

alter table public.usage_ledger drop constraint usage_ledger_metric_unit;

alter type public.usage_metric rename to usage_metric_pre_adr008;
create type public.usage_metric as enum ('storage_byte_seconds');

alter table public.usage_ledger
  alter column metric type public.usage_metric using metric::text::public.usage_metric;
alter table public.billing_meter_cursors
  alter column metric type public.usage_metric using metric::text::public.usage_metric;
-- Sent delivery exports stay for audit (event_name still names the retired meter).
alter table public.billing_exports
  alter column metric type public.usage_metric
  using (case when metric::text = 'delivery_bytes' then null else metric::text end)::public.usage_metric;

drop type public.usage_metric_pre_adr008;

alter table public.usage_ledger
  add constraint usage_ledger_metric_unit
  check (metric = 'storage_byte_seconds' and unit = 'byte_seconds');

-- ---------------------------------------------------------------------------------------------
-- 5. Queued notices for the removed `delivery_paused` template
-- ---------------------------------------------------------------------------------------------

delete from public.job_outbox
where event_name = 'email.send' and processed_at is null
  and payload ->> 'template' = 'delivery_paused';
