-- T06/T10: Postgres-backed rate limiting (FR-A05), guest reservation release, and upload tracking.
-- Forward-only in production. Rollback / forward-fix:
--   drop function public.rate_limit_hit(text, integer);
--   drop function public.prune_rate_limit_buckets(integer);
--   drop function public.release_guest_upload(uuid, bigint);
--   drop table public.rate_limit_buckets;
--   alter table public.upload_sessions drop column guest_session_id;
--   alter table public.media drop column checksum_sha256;
-- All objects are additive; no existing data is rewritten.

-- ---------------------------------------------------------------------------------------------
-- rate_limit_buckets: sliding-window counters (two fixed windows, weighted). `bucket_key` is
-- `{rule}:{hmac(subject)}` built in apps/web/src/lib/rate-limit.ts, so no raw IP, user id or
-- capability is ever stored. Service-only: RLS on, no browser grants, no policies.
-- ---------------------------------------------------------------------------------------------

create table public.rate_limit_buckets (
  bucket_key text not null check (char_length(bucket_key) between 1 and 200),
  window_start timestamptz not null,
  hit_count integer not null default 0 check (hit_count >= 0),
  -- Rows are only needed for the current and the previous window.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rate_limit_buckets_pkey primary key (bucket_key, window_start)
);

create index rate_limit_buckets_expires_at_idx on public.rate_limit_buckets (expires_at);

alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from anon, authenticated;
grant all on public.rate_limit_buckets to service_role;

-- Atomically counts one hit in the current window (single upsert, so concurrent requests can't
-- lose increments) and returns it with the previous window's count. Uses the DB clock so every
-- server instance agrees on window boundaries.
create function public.rate_limit_hit(bucket_key text, window_seconds integer)
returns table (current_count integer, previous_count integer, window_started_at timestamptz, now_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  ts timestamptz := now();
  w timestamptz;
begin
  if window_seconds is null or window_seconds < 1 then
    raise exception 'window_seconds must be >= 1' using errcode = 'invalid_parameter_value';
  end if;
  w := to_timestamp(floor(extract(epoch from ts) / window_seconds) * window_seconds);

  insert into public.rate_limit_buckets as b (bucket_key, window_start, hit_count, expires_at)
  values (rate_limit_hit.bucket_key, w, 1, w + make_interval(secs => 2 * window_seconds))
  on conflict on constraint rate_limit_buckets_pkey
  do update set hit_count = b.hit_count + 1, updated_at = ts
  returning b.hit_count into current_count;

  select b.hit_count into previous_count
  from public.rate_limit_buckets b
  where b.bucket_key = rate_limit_hit.bucket_key
    and b.window_start = w - make_interval(secs => window_seconds);

  previous_count := coalesce(previous_count, 0);
  window_started_at := w;
  now_at := ts;
  return next;
end;
$$;

-- Deletes up to `batch_size` expired buckets; called opportunistically by the limiter.
create function public.prune_rate_limit_buckets(batch_size integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.rate_limit_buckets
  where ctid in (
    select ctid from public.rate_limit_buckets
    where expires_at < now()
    limit greatest(batch_size, 1)
  );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- release_guest_upload: compensates reserve_guest_upload when an upload is aborted (T10).
-- Never drops below zero, so a duplicate release can't create negative usage.
-- ---------------------------------------------------------------------------------------------

create function public.release_guest_upload(guest_session_id uuid, file_bytes bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  released boolean;
begin
  if file_bytes is null or file_bytes <= 0 then
    return false;
  end if;

  update public.guest_sessions gs
  set reserved_file_count = greatest(gs.reserved_file_count - 1, 0),
      reserved_bytes = greatest(gs.reserved_bytes - release_guest_upload.file_bytes, 0)
  where gs.id = release_guest_upload.guest_session_id
  returning true into released;

  return coalesce(released, false);
end;
$$;

revoke all on function public.rate_limit_hit(text, integer) from public, anon, authenticated;
revoke all on function public.prune_rate_limit_buckets(integer) from public, anon, authenticated;
revoke all on function public.release_guest_upload(uuid, bigint) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer) to service_role;
grant execute on function public.prune_rate_limit_buckets(integer) to service_role;
grant execute on function public.release_guest_upload(uuid, bigint) to service_role;

-- ---------------------------------------------------------------------------------------------
-- upload_sessions.guest_session_id: the guest quota holding this reservation (null when the
-- reservation was admitted against an account plan). Abort releases exactly what was reserved,
-- even after the draft is claimed (T07 transfers pending sessions by clearing it).
-- ---------------------------------------------------------------------------------------------

alter table public.upload_sessions
  add column guest_session_id uuid references public.guest_sessions (id) on delete set null;

create index upload_sessions_guest_session_id_idx on public.upload_sessions (guest_session_id)
  where guest_session_id is not null;

-- ---------------------------------------------------------------------------------------------
-- media.checksum_sha256: client-declared SHA-256 of the original, recorded at completion and
-- verified by the image worker when it reads the object (docs/UPLOADS.md). Multipart ETags are
-- never treated as whole-file checksums (FR-M04).
-- ---------------------------------------------------------------------------------------------

alter table public.media
  add column checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$');
