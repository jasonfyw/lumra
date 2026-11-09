-- T27: versioned rate card in the database, storage accrual cursors for usage metering.
--
-- Forward-only in production. All objects are additive; existing `plans` rows keep their values
-- (the v1 version rows below carry exactly the same numbers). Rollback / forward-fix:
--   alter table public.plans drop constraint plans_current_rate_version_fkey;
--   drop trigger plans_apply_rate_version on public.plans;
--   drop function public.plans_apply_rate_version();
--   drop table public.storage_accrual_cursors;
--   drop table public.plan_rate_versions;          -- also drops its triggers
--   drop function public.plan_rate_versions_guard();
-- `usage_ledger` rows written by the metering jobs are append-only and are kept on rollback;
-- correct a bad row with a compensating entry, never by deleting it.

-- ---------------------------------------------------------------------------------------------
-- plan_rate_versions: immutable, versioned rate card (PRD §9.2, ADR-004, ADR-007).
-- One row per (plan, rate_version). `plans` keeps the *current* version pointer and a projection
-- of that version's rates (filled by the trigger below), so existing readers of `plans` keep
-- working. Rating a past period reads the version recorded on its `usage_ledger` rows.
-- A price change inserts a new version and then `update public.plans set rate_version = N`.
-- ---------------------------------------------------------------------------------------------

create table public.plan_rate_versions (
  plan_id text not null references public.plans (id) on delete restrict,
  rate_version integer not null check (rate_version >= 1),
  monthly_fee_micro_usd bigint not null check (monthly_fee_micro_usd >= 0),
  max_active_galleries integer check (max_active_galleries is null or max_active_galleries >= 0),
  max_storage_bytes bigint check (max_storage_bytes is null or max_storage_bytes >= 0),
  max_delivery_bytes_per_month bigint
    check (max_delivery_bytes_per_month is null or max_delivery_bytes_per_month >= 0),
  included_storage_gb_month integer not null check (included_storage_gb_month >= 0),
  included_delivery_gb integer not null check (included_delivery_gb >= 0),
  storage_overage_micro_usd_per_gb_month bigint
    check (storage_overage_micro_usd_per_gb_month is null or storage_overage_micro_usd_per_gb_month >= 0),
  delivery_overage_micro_usd_per_gb bigint
    check (delivery_overage_micro_usd_per_gb is null or delivery_overage_micro_usd_per_gb >= 0),
  default_overage_cap_micro_usd bigint
    check (default_overage_cap_micro_usd is null or default_overage_cap_micro_usd >= 0),
  branding_visible boolean not null,
  -- 'proposed' until the product owner confirms the commercial values (PRD §17, PLAN §5 #4).
  decision text not null default 'proposed' check (decision in ('proposed', 'confirmed')),
  notes text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_rate_versions_pkey primary key (plan_id, rate_version)
);

-- Rates are immutable once written: usage already rated under a version must stay reproducible.
-- The only permitted update is the owner decision 'proposed' -> 'confirmed' (plus notes).
create function public.plan_rate_versions_guard()
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
      new.max_storage_bytes, new.max_delivery_bytes_per_month, new.included_storage_gb_month,
      new.included_delivery_gb, new.storage_overage_micro_usd_per_gb_month,
      new.delivery_overage_micro_usd_per_gb, new.default_overage_cap_micro_usd,
      new.branding_visible, new.created_at)
     is distinct from
     (old.plan_id, old.rate_version, old.monthly_fee_micro_usd, old.max_active_galleries,
      old.max_storage_bytes, old.max_delivery_bytes_per_month, old.included_storage_gb_month,
      old.included_delivery_gb, old.storage_overage_micro_usd_per_gb_month,
      old.delivery_overage_micro_usd_per_gb, old.default_overage_cap_micro_usd,
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

create trigger plan_rate_versions_immutable before update or delete on public.plan_rate_versions
  for each row execute function public.plan_rate_versions_guard();

-- Seed: rate card v1 = PRD §9.2 launch rate card. Only the Pro $2.00 base fee is confirmed; every
-- other commercial value is Proposed (PRD §17) and awaits owner confirmation. Mirrors
-- RATE_CARD_V1 in packages/config/src/rate-card.ts (checked by packages/db/src/schema.test.ts).
insert into public.plan_rate_versions (
  plan_id, rate_version, monthly_fee_micro_usd,
  max_active_galleries, max_storage_bytes, max_delivery_bytes_per_month,
  included_storage_gb_month, included_delivery_gb,
  storage_overage_micro_usd_per_gb_month, delivery_overage_micro_usd_per_gb,
  default_overage_cap_micro_usd, branding_visible, decision, notes
) values
  ('free', 1, 0, 2, 1000000000, 3000000000, 0, 0, null, null, null, true, 'proposed',
   'PRD §9.2 launch rate card. Proposed: 2 active galleries, 3 GB/month delivery cap.'),
  ('pro', 1, 2000000, null, null, null, 20, 5, 100000, 30000, 10000000, false, 'proposed',
   'PRD §9.2 launch rate card. Confirmed: $2.00/month base and 20 GB-month '
   'included storage. Proposed: 5 GB delivery included, $0.10/GB-month, $0.03/GB, $10 default overage cap.');

-- plans.rate_version must name an existing version; its rate columns are a projection of it.
alter table public.plans
  add constraint plans_current_rate_version_fkey
  foreign key (id, rate_version) references public.plan_rate_versions (plan_id, rate_version);

create function public.plans_apply_rate_version()
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
  new.max_delivery_bytes_per_month := v.max_delivery_bytes_per_month;
  new.included_storage_gb_month := v.included_storage_gb_month;
  new.included_delivery_gb := v.included_delivery_gb;
  new.storage_overage_micro_usd_per_gb_month := v.storage_overage_micro_usd_per_gb_month;
  new.delivery_overage_micro_usd_per_gb := v.delivery_overage_micro_usd_per_gb;
  new.default_overage_cap_micro_usd := v.default_overage_cap_micro_usd;
  new.branding_visible := v.branding_visible;
  return new;
end;
$$;

create trigger plans_apply_rate_version before insert or update on public.plans
  for each row execute function public.plans_apply_rate_version();

-- Re-project the existing plan rows from their current rate version (picks up v1 values such as
-- Pro's 20 GB-month included storage, which differ from the core-schema seed).
update public.plans set rate_version = rate_version;

-- Public read, like `plans`: the pricing page shows the versioned rate card.
alter table public.plan_rate_versions enable row level security;
grant select on public.plan_rate_versions to anon, authenticated;
grant select, insert, update on public.plan_rate_versions to service_role;

create policy plan_rate_versions_public_read on public.plan_rate_versions
  for select to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------------------------
-- storage_accrual_cursors: where the storage GB-month accrual job (apps/worker cron) has
-- integrated each account up to, and the stored-bytes level sampled at that instant. Each run
-- appends `storage_byte_seconds` ledger rows for [accrued_through, run time) and advances the
-- cursor in the same transaction, guarded by the previous `accrued_through` (optimistic lock),
-- so overlapping or retried runs can never accrue a window twice. Service-only.
-- ---------------------------------------------------------------------------------------------

create table public.storage_accrual_cursors (
  account_id uuid primary key references public.billing_accounts (user_id) on delete cascade,
  accrued_through timestamptz not null,
  stored_bytes bigint not null check (stored_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index storage_accrual_cursors_accrued_through_idx
  on public.storage_accrual_cursors (accrued_through);

create trigger storage_accrual_cursors_set_updated_at before update on public.storage_accrual_cursors
  for each row execute function public.set_updated_at();

alter table public.storage_accrual_cursors enable row level security;
revoke all on public.storage_accrual_cursors from anon, authenticated;
grant all on public.storage_accrual_cursors to service_role;

