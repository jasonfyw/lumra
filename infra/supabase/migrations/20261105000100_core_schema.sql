-- T02: core schema (PRD §8). Forward-only in production; see infra/supabase/README.md for rollback notes.
-- Conventions: UUID PKs (gen_random_uuid), timestamptz (UTC), BIGINT bytes and integer micro-USD,
-- created_at/updated_at on mutable tables (maintained by public.set_updated_at()).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- Enums. Values MUST match the TypeScript sets (packages/contracts, packages/domain, packages/db);
-- packages/db/src/schema.test.ts asserts this. Add values with ALTER TYPE ... ADD VALUE.
-- ---------------------------------------------------------------------------------------------

-- GALLERY_STATUSES (@lumra/contracts). "expired" is derived from expires_at (PRD §7).
create type public.gallery_status as enum ('draft', 'published', 'deleted');

-- MEDIA_STATUSES (@lumra/contracts).
create type public.media_status as enum (
  'reserved', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'deleting', 'deleted'
);

-- ARCHIVE_STATUSES (@lumra/domain).
create type public.archive_status as enum (
  'requested', 'queued', 'running', 'ready', 'failed', 'expired', 'deleted'
);

-- UPLOAD_SESSION_STATUSES (@lumra/db).
create type public.upload_session_status as enum ('pending', 'completed', 'aborted', 'expired');

-- BILLING_ACCOUNT_STATUSES (@lumra/db), PRD §7 billing state machine.
create type public.billing_account_status as enum (
  'free', 'active', 'past_due', 'restricted', 'canceled'
);

-- BILLING_EXPORT_STATUSES (@lumra/db).
create type public.billing_export_status as enum ('pending', 'sent', 'failed');

-- GALLERY_EVENT_TYPES (@lumra/db). Item and archive downloads are distinguished (FR-N02).
create type public.gallery_event_type as enum ('view', 'item_download', 'archive_download');

-- USAGE_METRICS (@lumra/db; consumed by @lumra/billing). Quantities are raw integers in `unit`.
create type public.usage_metric as enum ('storage_byte_seconds', 'delivery_bytes');

-- WEBHOOK_EVENT_STATUSES (@lumra/db).
create type public.webhook_event_status as enum ('received', 'processed', 'failed', 'ignored');

-- ---------------------------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- plans: one row per PlanRates (packages/config/src/rate-card.ts), seeded with RATE_CARD_V1.
-- `id` is the PlanId ('free' | 'pro') rather than a UUID so @lumra/billing can join on it
-- directly; `rate_version` is recorded on every usage_ledger row (ADR-007). Money is micro-USD.
-- A new rate card version updates the row in a migration and bumps rate_version.
-- ---------------------------------------------------------------------------------------------

create table public.plans (
  id text primary key check (id in ('free', 'pro')),
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger plans_set_updated_at before update on public.plans
  for each row execute function public.set_updated_at();

insert into public.plans (
  id, rate_version, monthly_fee_micro_usd,
  max_active_galleries, max_storage_bytes, max_delivery_bytes_per_month,
  included_storage_gb_month, included_delivery_gb,
  storage_overage_micro_usd_per_gb_month, delivery_overage_micro_usd_per_gb,
  default_overage_cap_micro_usd, branding_visible
) values
  ('free', 1, 0, 2, 1000000000, 3000000000, 0, 0, null, null, null, true),
  ('pro', 1, 2000000, null, null, null, 2, 5, 100000, 30000, 10000000, false);

-- ---------------------------------------------------------------------------------------------
-- profiles / billing_accounts (created by public.handle_new_user on auth.users insert)
-- ---------------------------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text check (display_name is null or char_length(display_name) between 1 and 100),
  plan_id text not null default 'free' references public.plans (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_plan_id_idx on public.profiles (plan_id);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.billing_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status public.billing_account_status not null default 'free',
  -- Overage spend cap (PRD §9.4); null = plan default / not applicable (Free).
  spend_cap_micro_usd bigint check (spend_cap_micro_usd is null or spend_cap_micro_usd >= 0),
  -- Percent-of-cap alert thresholds (PRD §9.4).
  warning_thresholds smallint[] not null default '{50,80,100}'
    check (
      cardinality(warning_thresholds) <= 10
      and 1 <= all (warning_thresholds)
      and 100 >= all (warning_thresholds)
    ),
  billing_period_start timestamptz,
  billing_period_end timestamptz,
  -- Overdue policy transitions (PRD §9.4); set when entering the state.
  past_due_since timestamptz,
  restricted_since timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_accounts_period_order check (
    billing_period_start is null or billing_period_end is null or billing_period_end > billing_period_start
  )
);

create trigger billing_accounts_set_updated_at before update on public.billing_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- guest_sessions (FR-A01..A03). Quota backstop CHECKs mirror GUEST_LIMITS; the authoritative
-- atomic check is public.reserve_guest_upload().
-- ---------------------------------------------------------------------------------------------

create table public.guest_sessions (
  id uuid primary key default gen_random_uuid(),
  capability_hash text not null unique,
  expires_at timestamptz not null,
  claimed_by_user_id uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  reserved_file_count integer not null default 0 check (reserved_file_count between 0 and 20),
  reserved_bytes bigint not null default 0 check (reserved_bytes between 0 and 250000000),
  rate_key_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index guest_sessions_expires_at_idx on public.guest_sessions (expires_at);
create index guest_sessions_unclaimed_expires_at_idx on public.guest_sessions (expires_at)
  where claimed_at is null;
create index guest_sessions_claimed_by_user_id_idx on public.guest_sessions (claimed_by_user_id)
  where claimed_by_user_id is not null;

create trigger guest_sessions_set_updated_at before update on public.guest_sessions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- galleries
-- ---------------------------------------------------------------------------------------------

create table public.galleries (
  id uuid primary key default gen_random_uuid(),
  -- Account deletion must remove galleries (and their R2 objects) first, hence RESTRICT.
  owner_id uuid references auth.users (id) on delete restrict,
  guest_session_id uuid references public.guest_sessions (id) on delete set null,
  claimed_at timestamptz,
  slug text not null unique check (slug ~ '^[A-Za-z0-9_-]{8,64}$'),
  title text not null default 'Untitled gallery' check (char_length(title) between 1 and 200),
  status public.gallery_status not null default 'draft',
  password_hash text,
  access_version integer not null default 1 check (access_version >= 1),
  cover_media_id uuid,
  expires_at timestamptz,
  published_at timestamptz,
  content_version integer not null default 1 check (content_version >= 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Before claim: exactly one of owner_id / guest_session_id. After claim (claimed_at set) the
  -- creator owns it and guest_session_id may be retained as provenance.
  constraint galleries_ownership check (
    (owner_id is null and guest_session_id is not null and claimed_at is null)
    or (owner_id is not null and guest_session_id is null and claimed_at is null)
    or (owner_id is not null and claimed_at is not null)
  ),
  -- Guests publish by authenticating first (J1): a published gallery always has an owner.
  constraint galleries_published_has_owner check (status <> 'published' or owner_id is not null),
  constraint galleries_published_at_set check (status <> 'published' or published_at is not null),
  constraint galleries_deleted_consistent check ((status = 'deleted') = (deleted_at is not null))
);

create index galleries_owner_updated_active_idx on public.galleries (owner_id, updated_at desc)
  where deleted_at is null;
create index galleries_guest_session_id_idx on public.galleries (guest_session_id)
  where guest_session_id is not null;
create index galleries_deleted_at_idx on public.galleries (deleted_at) where deleted_at is not null;

create trigger galleries_set_updated_at before update on public.galleries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- media / media_variants / upload_sessions
-- ---------------------------------------------------------------------------------------------

create table public.media (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  original_key text not null unique,
  filename text not null check (char_length(filename) between 1 and 255),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 50000000),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  taken_at timestamptz,
  -- Fractional ordering key (FR-G03); "C" collation gives stable byte-wise ordering.
  sort_key text collate "C" not null check (char_length(sort_key) between 1 and 128),
  status public.media_status not null default 'reserved',
  upload_session_id uuid,
  ready_at timestamptz,
  failure_code text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_ready_at_set check (status <> 'ready' or ready_at is not null),
  constraint media_deleted_at_set check (status not in ('deleting', 'deleted') or deleted_at is not null)
);

-- Base-62 fractional keys from @lumra/domain ordering compare by char code; keep "C" collation.
create index media_gallery_sort_active_idx on public.media (gallery_id, sort_key collate "C")
  where deleted_at is null;
create index media_gallery_status_idx on public.media (gallery_id, status);
-- Reconciliation of stale reservations (PRD §6.3, §7).
create index media_pending_updated_idx on public.media (updated_at)
  where status in ('reserved', 'uploading', 'uploaded', 'processing');

create trigger media_set_updated_at before update on public.media
  for each row execute function public.set_updated_at();

alter table public.galleries
  add constraint galleries_cover_media_id_fkey
  foreign key (cover_media_id) references public.media (id) on delete set null;

create table public.media_variants (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references public.media (id) on delete cascade,
  variant text not null check (variant ~ '^[a-z0-9_]{1,32}$'),
  object_key text not null unique,
  mime text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  byte_size bigint not null check (byte_size > 0),
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_variants_media_variant_key unique (media_id, variant)
);

create trigger media_variants_set_updated_at before update on public.media_variants
  for each row execute function public.set_updated_at();

create table public.upload_sessions (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  media_id uuid not null references public.media (id) on delete cascade,
  provider_upload_id text,
  part_size integer not null check (part_size > 0),
  reserved_bytes bigint not null check (reserved_bytes > 0),
  expires_at timestamptz not null,
  status public.upload_session_status not null default 'pending',
  idempotency_key text not null unique,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upload_sessions_completed_at_set check (status <> 'completed' or completed_at is not null)
);

create index upload_sessions_media_id_idx on public.upload_sessions (media_id);
create index upload_sessions_gallery_id_idx on public.upload_sessions (gallery_id);
create index upload_sessions_pending_expires_idx on public.upload_sessions (expires_at)
  where status = 'pending';

create trigger upload_sessions_set_updated_at before update on public.upload_sessions
  for each row execute function public.set_updated_at();

alter table public.media
  add constraint media_upload_session_id_fkey
  foreign key (upload_session_id) references public.upload_sessions (id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- archives
-- ---------------------------------------------------------------------------------------------

create table public.archive_jobs (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  requested_by_session_hash text not null,
  content_version integer not null check (content_version >= 1),
  status public.archive_status not null default 'requested',
  parts_expected integer check (parts_expected is null or parts_expected >= 1),
  progress_pct smallint not null default 0 check (progress_pct between 0 and 100),
  expires_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index archive_jobs_status_created_idx on public.archive_jobs (status, created_at);
create index archive_jobs_gallery_active_idx on public.archive_jobs (gallery_id, content_version)
  where status in ('requested', 'queued', 'running', 'ready');

create trigger archive_jobs_set_updated_at before update on public.archive_jobs
  for each row execute function public.set_updated_at();

create table public.archive_parts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.archive_jobs (id) on delete cascade,
  part_no integer not null check (part_no >= 1),
  object_key text not null unique,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint archive_parts_job_part_key unique (job_id, part_no)
);

create trigger archive_parts_set_updated_at before update on public.archive_parts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- viewer access + analytics
-- ---------------------------------------------------------------------------------------------

create table public.gallery_access_sessions (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  token_hash text not null unique,
  access_version integer not null check (access_version >= 1),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index gallery_access_sessions_gallery_id_idx on public.gallery_access_sessions (gallery_id);
create index gallery_access_sessions_expires_at_idx on public.gallery_access_sessions (expires_at);

-- Append-only event log (no updated_at).
create table public.gallery_events (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references public.galleries (id) on delete cascade,
  event_type public.gallery_event_type not null,
  media_id uuid references public.media (id) on delete set null,
  anonymous_session_hash text not null,
  -- 30-minute window index: floor(epoch_seconds / 1800) (FR-N02).
  window_bucket bigint not null,
  bytes_served bigint not null default 0 check (bytes_served >= 0),
  idempotency_key text unique,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index gallery_events_gallery_occurred_idx on public.gallery_events (gallery_id, occurred_at);
-- One eligible view per anonymous session per gallery per window (FR-N02).
create unique index gallery_events_view_dedupe_idx
  on public.gallery_events (gallery_id, anonymous_session_hash, window_bucket)
  where event_type = 'view';

-- ---------------------------------------------------------------------------------------------
-- billing: usage ledger + Stripe exports
-- ---------------------------------------------------------------------------------------------

-- Append-only, authoritative for real-time caps (ADR-004). Corrections are compensating rows.
create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.billing_accounts (user_id) on delete restrict,
  metric public.usage_metric not null,
  -- Raw integer quantity in `unit` (byte-seconds or bytes); negative only for compensating rows.
  quantity_micro_units bigint not null,
  unit text not null,
  source_id text not null check (char_length(source_id) between 1 and 200),
  event_time timestamptz not null,
  period_start timestamptz not null,
  rating_version integer not null check (rating_version >= 1),
  estimated_cost_micro_usd bigint not null default 0,
  created_at timestamptz not null default now(),
  constraint usage_ledger_metric_source_key unique (metric, source_id),
  constraint usage_ledger_metric_unit check (
    (metric = 'storage_byte_seconds' and unit = 'byte_seconds')
    or (metric = 'delivery_bytes' and unit = 'bytes')
  )
);

create index usage_ledger_account_period_metric_idx
  on public.usage_ledger (account_id, period_start, metric);

create function public.usage_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'usage_ledger is append-only; insert a compensating entry instead'
    using errcode = 'restrict_violation';
end;
$$;

create trigger usage_ledger_no_update_delete before update or delete on public.usage_ledger
  for each row execute function public.usage_ledger_append_only();

create table public.billing_exports (
  id uuid primary key default gen_random_uuid(),
  billing_account_id uuid not null references public.billing_accounts (user_id) on delete restrict,
  ledger_cursor text not null,
  -- Stable Stripe idempotency key (PRD §9.5).
  idempotency_key text not null unique,
  stripe_event_id text unique,
  status public.billing_export_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index billing_exports_account_created_idx on public.billing_exports (billing_account_id, created_at);
create index billing_exports_pending_idx on public.billing_exports (created_at) where status <> 'sent';

create trigger billing_exports_set_updated_at before update on public.billing_exports
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- transactional outbox + provider webhook dedupe
-- ---------------------------------------------------------------------------------------------

create table public.job_outbox (
  id uuid primary key default gen_random_uuid(),
  event_name text not null check (event_name ~ '^[a-z][a-z0-9_.]{0,63}$'),
  aggregate_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index job_outbox_unprocessed_idx on public.job_outbox (available_at) where processed_at is null;
create index job_outbox_aggregate_idx on public.job_outbox (aggregate_id);

create trigger job_outbox_set_updated_at before update on public.job_outbox
  for each row execute function public.set_updated_at();

create table public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe')),
  provider_event_id text not null,
  event_type text,
  status public.webhook_event_status not null default 'received',
  received_at timestamptz not null default now(),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_webhook_events_provider_event_key unique (provider, provider_event_id)
);

create index provider_webhook_events_unhandled_idx on public.provider_webhook_events (received_at)
  where handled_at is null;

create trigger provider_webhook_events_set_updated_at before update on public.provider_webhook_events
  for each row execute function public.set_updated_at();
