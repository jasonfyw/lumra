-- T12: record the original's EXIF orientation (FR-M07 "track width, height, orientation …").
-- The derivative pipeline writes it together with width/height/taken_at when media becomes ready.
-- Additive and nullable, so it is safe to apply before the worker deploy.
-- Rollback / forward-fix: `alter table public.media drop column orientation;` (no other object
-- depends on it; the worker tolerates the column being absent only if this migration is reverted
-- together with the T12 worker deploy).

alter table public.media
  add column orientation smallint
  check (orientation is null or orientation between 1 and 8);

comment on column public.media.orientation is
  'EXIF orientation (1-8) of the original; derivatives are already rotated. Null when absent.';
