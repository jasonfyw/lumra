-- Gallery analytics (FR-N02, T26): per-gallery view / download counters for the owner.
--
-- Design: `gallery_events` (core schema) stays the append-only, privacy-safe event log. It already
-- carries the per-window view dedupe (unique index on gallery, anonymous_session_hash, window)
-- and the optional idempotency key. This migration adds one narrow aggregate table,
-- `gallery_stats` (one row per gallery), and `record_gallery_event`, a SECURITY DEFINER function
-- that inserts the event and bumps the counters in the same statement-level transaction, so the
-- numbers cannot drift from the log and a dashboard read is a single primary-key lookup instead
-- of a COUNT over an ever-growing log. `anonymous_session_hash` is a salted, daily-rotating,
-- per-gallery HMAC computed by the app (no IP, no PII, nothing stored that links days or
-- galleries), so `unique_visitor_count` means "unique visitors per day, summed".
--
-- RLS (ADR-005): the owner may SELECT their own gallery's row; no browser role has any write
-- privilege, and the function is executable by service_role only.
--
-- Rollback / forward-fix (counters are derived data; the event log is untouched):
--   drop function public.record_gallery_event(uuid, public.gallery_event_type, uuid, text, bigint, text);
--   drop table public.gallery_stats;
-- To rebuild counters after a bad deploy instead of dropping, recompute from the log:
--   update public.gallery_stats s set
--     view_count = (select count(*) from public.gallery_events e
--                    where e.gallery_id = s.gallery_id and e.event_type = 'view'), ...
-- Counters can also be re-seeded with a forward-fix migration; nothing else depends on them.

create table public.gallery_stats (
  gallery_id uuid primary key references public.galleries (id) on delete cascade,
  view_count bigint not null default 0 check (view_count >= 0),
  item_download_count bigint not null default 0 check (item_download_count >= 0),
  archive_download_count bigint not null default 0 check (archive_download_count >= 0),
  unique_visitor_count bigint not null default 0 check (unique_visitor_count >= 0),
  last_viewed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.gallery_stats enable row level security;

grant all on public.gallery_stats to service_role;
grant select on public.gallery_stats to authenticated;

create policy gallery_stats_owner_read on public.gallery_stats
  for select to authenticated
  using (
    exists (
      select 1
      from public.galleries g
      where g.id = gallery_stats.gallery_id
        and g.owner_id = (select auth.uid())
        and g.deleted_at is null
    )
  );

-- Records one event and bumps the counters. Returns true when it counted, false when it was a
-- duplicate (same visitor + 30-minute window for views, or a repeated idempotency key).
create function public.record_gallery_event(
  p_gallery_id uuid,
  p_event_type public.gallery_event_type,
  p_media_id uuid,
  p_visitor_hash text,
  p_window_bucket bigint,
  p_idempotency_key text default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_new_visitor boolean := false;
  v_view integer := 0;
  v_item integer := 0;
  v_archive integer := 0;
begin
  if p_event_type = 'view' then
    -- Serialise first-views of one visitor so concurrent windows cannot both look "new".
    perform pg_advisory_xact_lock(hashtextextended(p_gallery_id::text || ':' || p_visitor_hash, 0));
    -- The hash rotates daily, so any earlier view with it is the same visitor on the same day.
    v_new_visitor := not exists (
      select 1 from public.gallery_events e
      where e.gallery_id = p_gallery_id
        and e.anonymous_session_hash = p_visitor_hash
        and e.event_type = 'view'
    );
  end if;

  insert into public.gallery_events
    (gallery_id, event_type, media_id, anonymous_session_hash, window_bucket, idempotency_key)
  values
    (p_gallery_id, p_event_type, p_media_id, p_visitor_hash, p_window_bucket, p_idempotency_key)
  on conflict do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false;
  end if;

  if p_event_type = 'view' then
    v_view := 1;
  elsif p_event_type = 'item_download' then
    v_item := 1;
  else
    v_archive := 1;
  end if;

  insert into public.gallery_stats as s
    (gallery_id, view_count, item_download_count, archive_download_count,
     unique_visitor_count, last_viewed_at)
  values
    (p_gallery_id, v_view, v_item, v_archive, case when v_new_visitor then 1 else 0 end,
     case when v_view = 1 then now() end)
  on conflict (gallery_id) do update set
    view_count = s.view_count + excluded.view_count,
    item_download_count = s.item_download_count + excluded.item_download_count,
    archive_download_count = s.archive_download_count + excluded.archive_download_count,
    unique_visitor_count = s.unique_visitor_count + excluded.unique_visitor_count,
    last_viewed_at = coalesce(excluded.last_viewed_at, s.last_viewed_at),
    updated_at = now();

  return true;
end;
$$;

revoke all on function public.record_gallery_event(uuid, public.gallery_event_type, uuid, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.record_gallery_event(uuid, public.gallery_event_type, uuid, text, bigint, text)
  to service_role;
