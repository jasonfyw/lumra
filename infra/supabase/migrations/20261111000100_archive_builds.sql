-- T24: background "Download all" archives (FR-D02/D03, ADR-003).
--
-- Additive only: new nullable/defaulted columns on archive_jobs / archive_parts and one index.
-- Both tables are service-only (RLS on, no policies; 20261105000300), so nothing changes for the
-- browser roles. Existing rows (there are none in production before T24) get the defaults.
--
-- Rollback / forward-fix (archive rows are temporary, 24 h; dropping them loses nothing durable):
--   delete from public.archive_jobs;              -- cascades to archive_parts
--   drop index public.archive_jobs_ready_expiry_idx;
--   alter table public.archive_parts drop column entries, drop column item_count,
--     drop column source_bytes, drop column upload_id, drop column completed_at;
--   alter table public.archive_jobs drop column access_version, drop column source_fingerprint,
--     drop column item_count, drop column total_bytes, drop column lease_until,
--     drop column started_at, drop column completed_at;
-- Any temp-archives objects left behind are removed by the bucket's 1-day lifecycle rule.

-- ---------------------------------------------------------------------------------------------
-- archive_jobs
-- ---------------------------------------------------------------------------------------------

-- Gallery access_version when the job was requested. A password change/revocation bumps it, so
-- the job (and its download links) stop working for everyone, like gallery sessions do.
alter table public.archive_jobs add column access_version integer not null default 1
  check (access_version >= 0);

-- SHA-256 (hex) over the ordered (media id, entry name) list the job was partitioned from. Reuse
-- requires the same content_version AND fingerprint, because a photo finishing processing does
-- not bump content_version but does change what "Download all" should contain.
alter table public.archive_jobs add column source_fingerprint text
  check (source_fingerprint is null or source_fingerprint ~ '^[a-f0-9]{64}$');

alter table public.archive_jobs add column item_count integer not null default 0
  check (item_count >= 0);

-- Sum of the originals' byte sizes (decimal bytes), i.e. the ZIP payload before headers.
alter table public.archive_jobs add column total_bytes bigint not null default 0
  check (total_bytes >= 0);

-- Build lease: a worker owns the job until this time; a concurrent redelivery backs off.
alter table public.archive_jobs add column lease_until timestamptz;

alter table public.archive_jobs add column started_at timestamptz;

alter table public.archive_jobs add column completed_at timestamptz;

-- TTL sweep (T25): ready jobs ordered by expiry.
create index archive_jobs_ready_expiry_idx on public.archive_jobs (expires_at)
  where status = 'ready';

-- ---------------------------------------------------------------------------------------------
-- archive_parts
-- ---------------------------------------------------------------------------------------------

-- Ordered entries of this part, fixed at request time so a retry rebuilds byte-identical
-- content: [{"mediaId": uuid, "name": sanitized unique entry name, "bytes": int}, ...].
alter table public.archive_parts add column entries jsonb not null default '[]'::jsonb
  check (jsonb_typeof(entries) = 'array');

alter table public.archive_parts add column item_count integer not null default 0
  check (item_count >= 0);

alter table public.archive_parts add column source_bytes bigint not null default 0
  check (source_bytes >= 0);

-- R2 multipart upload id of an in-progress build, so a retry can abort the abandoned upload.
alter table public.archive_parts add column upload_id text;

-- Set when the ZIP object is complete in temp-archives (byte_size is set at the same time).
alter table public.archive_parts add column completed_at timestamptz;
