-- T13: physical-deletion backstop sweep (FR-G06). The worker's */15 cron looks for media that
-- were soft-deleted (deleted_at set) more than an hour ago but never reached `deleted` (their
-- `media.delete` job was lost or failed). Only rows in that window are indexed, so the index
-- stays tiny: rows leave it once the purge marks them `deleted`.
-- Additive (no data change); safe to apply before or after the worker deploy.
-- Rollback / forward-fix: `drop index if exists public.media_purge_pending_idx;` (the sweep then
-- falls back to a sequential scan of public.media; nothing else depends on the index).

create index if not exists media_purge_pending_idx on public.media (deleted_at)
  where deleted_at is not null and status <> 'deleted';
