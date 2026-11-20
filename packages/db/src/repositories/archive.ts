/**
 * SERVER-ONLY. Archive build persistence for the job Worker (T24/T25, ADR-003). Raw SQL over
 * postgres.js so the conditional transitions (PRD §7 archive machine, `ARCHIVE_TRANSITIONS`)
 * and the content-version guard are explicit. `archive_jobs` / `archive_parts` are service-only.
 */
import type postgres from 'postgres';
import {
  archivePartEntriesSchema,
  type ArchiveFailureCode,
  type ArchivePartEntry,
} from '@lumra/contracts';
import type { ArchiveStatus } from '@lumra/domain';
import { pgArray } from '../client';

export interface ArchiveBuildPart {
  id: string;
  partNo: number;
  objectKey: string;
  entries: ArchivePartEntry[];
  itemCount: number;
  sourceBytes: number;
  uploadId: string | null;
  byteSize: number | null;
  completed: boolean;
}

export interface ArchiveBuildJob {
  id: string;
  galleryId: string;
  status: ArchiveStatus;
  contentVersion: number;
  totalBytes: number;
  partsExpected: number;
  parts: ArchiveBuildPart[];
}

export interface ArchiveGalleryState {
  contentVersion: number;
  /** Published and not soft-deleted (expiry is enforced at delivery time, not here). */
  available: boolean;
}

export interface ArchiveMediaRow {
  id: string;
  originalKey: string;
  /** `ready` and neither the media nor its gallery soft-deleted. */
  deliverable: boolean;
  createdAt: Date;
}

export type ArchiveClaim = 'claimed' | 'busy' | 'not_buildable' | 'missing';

export interface ArchiveRepository {
  getJob(jobId: string): Promise<ArchiveBuildJob | null>;
  /**
   * Takes the build lease: `queued → running` (or resumes `running`) when no live lease exists.
   * `busy`: another delivery holds the lease; `not_buildable`: the job is terminal.
   */
  claim(jobId: string, leaseMs: number): Promise<ArchiveClaim>;
  galleryState(galleryId: string): Promise<ArchiveGalleryState | null>;
  media(galleryId: string, mediaIds: readonly string[]): Promise<ArchiveMediaRow[]>;
  setPartUpload(partId: string, uploadId: string | null): Promise<void>;
  /**
   * Records a finished part, in one transaction with a re-check that the gallery is still
   * available at the job's `content_version`. False ⇒ the gallery changed; nothing written.
   */
  completePart(input: {
    jobId: string;
    partId: string;
    byteSize: number;
    contentVersion: number;
  }): Promise<boolean>;
  /** Monotonic progress while `running`. */
  setProgress(jobId: string, pct: number): Promise<void>;
  /** `running → ready` when every part is complete and the content version still matches. */
  markReady(jobId: string, expiresAt: Date, contentVersion: number): Promise<boolean>;
  /** Any non-terminal status → `failed` with `failure_code`. */
  markFailed(jobId: string, code: ArchiveFailureCode): Promise<boolean>;
  releaseLease(jobId: string): Promise<void>;
  /**
   * TTL sweep (T25): `ready → expired` for up to `limit` jobs whose `expires_at` has passed.
   * Returns their parts' object keys so the caller can delete them.
   */
  expireDue(now: Date, limit: number): Promise<{ jobId: string; objectKeys: string[] }[]>;
  /** Non-terminal jobs untouched since `before` with no live lease → `failed` (`stalled`). */
  failStalled(before: Date): Promise<number>;
}

interface JobRow {
  id: string;
  gallery_id: string;
  status: ArchiveStatus;
  content_version: number;
  total_bytes: string | number;
  parts_expected: number | null;
}

interface PartRow {
  id: string;
  part_no: number;
  object_key: string;
  entries: unknown;
  item_count: number;
  source_bytes: string | number;
  upload_id: string | null;
  byte_size: string | number | null;
  completed_at: Date | null;
}

/** A transaction, or a savepoint when `sql` is already one (integration tests roll back). */
function atomically<T>(
  sql: postgres.Sql,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const maybeTx = sql as unknown as Partial<postgres.TransactionSql>;
  if (typeof sql.begin !== 'function' && typeof maybeTx.savepoint === 'function') {
    return maybeTx.savepoint(fn) as Promise<T>;
  }
  return sql.begin(fn) as Promise<T>;
}

export function createArchiveRepository(sql: postgres.Sql): ArchiveRepository {
  return {
    async getJob(jobId) {
      const [job] = await sql<JobRow[]>`
        select id, gallery_id, status, content_version, total_bytes, parts_expected
        from public.archive_jobs where id = ${jobId}`;
      if (!job) return null;
      const parts = await sql<PartRow[]>`
        select id, part_no, object_key, entries, item_count, source_bytes, upload_id, byte_size,
               completed_at
        from public.archive_parts where job_id = ${jobId} order by part_no`;
      return {
        id: job.id,
        galleryId: job.gallery_id,
        status: job.status,
        contentVersion: job.content_version,
        totalBytes: Number(job.total_bytes),
        partsExpected: job.parts_expected ?? parts.length,
        parts: parts.map((p) => ({
          id: p.id,
          partNo: p.part_no,
          objectKey: p.object_key,
          // Validated: the worker turns these into R2 keys and ZIP entry names.
          entries: archivePartEntriesSchema.parse(
            typeof p.entries === 'string' ? JSON.parse(p.entries) : p.entries,
          ),
          itemCount: p.item_count,
          sourceBytes: Number(p.source_bytes),
          uploadId: p.upload_id,
          byteSize: p.byte_size === null ? null : Number(p.byte_size),
          completed: p.completed_at !== null,
        })),
      };
    },

    async claim(jobId, leaseMs) {
      const rows = await sql<{ status: ArchiveStatus; claimed: boolean }[]>`
        with target as (
          select id, status,
                 (status in ('queued', 'running')
                   and (lease_until is null or lease_until < now())) as claimable
          from public.archive_jobs where id = ${jobId}
          for update
        ), updated as (
          update public.archive_jobs j
          set status = 'running',
              started_at = coalesce(j.started_at, now()),
              lease_until = now() + ${leaseMs}::double precision * interval '1 millisecond'
          from target t
          where j.id = t.id and t.claimable
          returning j.id
        )
        select t.status, exists (select 1 from updated) as claimed from target t`;
      const row = rows[0];
      if (!row) return 'missing';
      if (row.claimed) return 'claimed';
      return row.status === 'queued' || row.status === 'running' ? 'busy' : 'not_buildable';
    },

    async galleryState(galleryId) {
      const [row] = await sql<{ content_version: number; available: boolean }[]>`
        select content_version, (status = 'published' and deleted_at is null) as available
        from public.galleries where id = ${galleryId}`;
      return row ? { contentVersion: row.content_version, available: row.available } : null;
    },

    async media(galleryId, mediaIds) {
      if (mediaIds.length === 0) return [];
      const rows = await sql<
        { id: string; original_key: string; deliverable: boolean; created_at: Date }[]
      >`
        select m.id, m.original_key, m.created_at,
               (m.status = 'ready' and m.deleted_at is null and g.deleted_at is null)
                 as deliverable
        from public.media m
        join public.galleries g on g.id = m.gallery_id
        where m.gallery_id = ${galleryId}
          and m.id = any(${pgArray(mediaIds)}::uuid[])`;
      return rows.map((r) => ({
        id: r.id,
        originalKey: r.original_key,
        deliverable: r.deliverable,
        createdAt: new Date(r.created_at),
      }));
    },

    async setPartUpload(partId, uploadId) {
      await sql`update public.archive_parts set upload_id = ${uploadId} where id = ${partId}`;
    },

    async completePart({ jobId, partId, byteSize, contentVersion }) {
      return atomically(sql, async (tx) => {
        const [row] = await tx<{ ok: boolean }[]>`
          select (j.status = 'running' and g.content_version = ${contentVersion}
                  and g.status = 'published' and g.deleted_at is null) as ok
          from public.archive_jobs j
          join public.galleries g on g.id = j.gallery_id
          where j.id = ${jobId}
          for update of j
          for share of g`;
        if (!row?.ok) return false;
        await tx`
          update public.archive_parts
          set byte_size = ${byteSize}, completed_at = now(), upload_id = null
          where id = ${partId} and job_id = ${jobId}`;
        return true;
      });
    },

    async setProgress(jobId, pct) {
      const value = Math.max(0, Math.min(99, Math.floor(pct)));
      await sql`
        update public.archive_jobs set progress_pct = greatest(progress_pct, ${value})
        where id = ${jobId} and status = 'running' and progress_pct < ${value}`;
    },

    async markReady(jobId, expiresAt, contentVersion) {
      const rows = await sql`
        update public.archive_jobs j
        set status = 'ready', progress_pct = 100, expires_at = ${expiresAt},
            completed_at = now(), lease_until = null, failure_code = null
        from public.galleries g
        where j.id = ${jobId}
          and g.id = j.gallery_id
          and j.status = 'running'
          and g.content_version = ${contentVersion}
          and g.status = 'published' and g.deleted_at is null
          and not exists (
            select 1 from public.archive_parts p
            where p.job_id = j.id and p.completed_at is null)
        returning j.id`;
      return rows.length === 1;
    },

    async markFailed(jobId, code) {
      const rows = await sql`
        update public.archive_jobs
        set status = 'failed', failure_code = ${code}, lease_until = null
        where id = ${jobId} and status in ('requested', 'queued', 'running')
        returning id`;
      return rows.length === 1;
    },

    async releaseLease(jobId) {
      await sql`update public.archive_jobs set lease_until = null where id = ${jobId}`;
    },

    async expireDue(now, limit) {
      const jobs = await sql<{ id: string }[]>`
        update public.archive_jobs set status = 'expired', lease_until = null
        where id in (
          select id from public.archive_jobs
          where status = 'ready' and expires_at <= ${now}
          order by expires_at
          limit ${limit}
          for update skip locked)
        returning id`;
      if (jobs.length === 0) return [];
      const ids = jobs.map((j) => j.id);
      const parts = await sql<{ job_id: string; object_key: string }[]>`
        select job_id, object_key from public.archive_parts
        where job_id = any(${pgArray(ids)}::uuid[])`;
      return ids.map((jobId) => ({
        jobId,
        objectKeys: parts.filter((p) => p.job_id === jobId).map((p) => p.object_key),
      }));
    },

    async failStalled(before) {
      const rows = await sql`
        update public.archive_jobs
        set status = 'failed', failure_code = 'stalled', lease_until = null
        where status in ('requested', 'queued', 'running')
          and updated_at < ${before}
          and (lease_until is null or lease_until < now())
        returning id`;
      return rows.length;
    },
  };
}
