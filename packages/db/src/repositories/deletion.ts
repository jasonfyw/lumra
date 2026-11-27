/**
 * SERVER-ONLY. Physical-deletion persistence (FR-G06, T13): reads what the worker's purge must
 * remove from R2 and records the result. Raw SQL over postgres.js like the other worker
 * repositories. Every write is conditional and idempotent, so concurrent or repeated purges
 * (queue redelivery, the backstop sweep) converge on the same rows.
 */
import type postgres from 'postgres';
import type { MediaStatus } from '@lumra/contracts';
import { pgArray } from '../client';

export interface MediaPurgeRow {
  id: string;
  galleryId: string;
  status: MediaStatus;
  originalKey: string;
  /** `media.deleted_at` is set. */
  mediaDeleted: boolean;
  /** `galleries.deleted_at` is set. */
  galleryDeleted: boolean;
  /** Object keys of every `media_variants` row (rows are kept after the purge). */
  variantKeys: string[];
}

export interface GalleryDeletionRow {
  id: string;
  deleted: boolean;
}

export interface DeletionRepository {
  /** Media rows (any status, deleted ones included) with their variant keys; missing ids omitted. */
  getMediaForPurge(mediaIds: readonly string[]): Promise<MediaPurgeRow[]>;
  /**
   * Marks soft-deleted media (or media of a deleted gallery) `deleted`, filling `deleted_at` when
   * only the gallery was deleted. Live media and rows already `deleted` are left alone. Returns
   * the ids that changed.
   */
  markMediaDeleted(mediaIds: readonly string[]): Promise<string[]>;
  /** Null when the gallery row no longer exists. */
  getGalleryDeletion(galleryId: string): Promise<GalleryDeletionRow | null>;
  /** Ids of a gallery's media not yet `deleted`, keyset-paginated by id. */
  listGalleryMediaToPurge(
    galleryId: string,
    afterId: string | null,
    limit: number,
  ): Promise<string[]>;
  /** Marks the gallery's archive jobs `deleted` (their parts' objects are already removed). */
  markGalleryArchivesDeleted(galleryId: string): Promise<number>;
  /**
   * Sweep: galleries deleted before `cutoff` that still have media not `deleted` or archive
   * jobs not `deleted` (oldest first).
   */
  listStuckGalleries(cutoff: Date, limit: number): Promise<string[]>;
  /**
   * Sweep: media soft-deleted before `cutoff` and still not `deleted` (oldest first); served by
   * the partial index `media_purge_pending_idx`.
   */
  listStuckMedia(cutoff: Date, limit: number): Promise<string[]>;
}

/** Guest draft expiry, driving the same purge as a deletion (separate so purge fakes stay small). */
export interface GuestDraftExpiryRepository {
  /**
   * Guest draft expiry (FR-A03): soft-deletes up to `limit` draft galleries of guest sessions
   * that expired at or before `now` and were never claimed (gallery `deleted`, `deleted_at` set,
   * `access_version` bumped), expires their pending upload sessions and writes a deduplicated
   * `gallery.delete` outbox row for each, all in one statement. The existing purge then removes
   * the R2 objects. Idempotent: deleted galleries are never selected again. Returns gallery ids.
   */
  expireGuestDrafts(now: Date, limit: number): Promise<string[]>;
}

interface MediaRow {
  id: string;
  gallery_id: string;
  status: MediaStatus;
  original_key: string;
  media_deleted: boolean;
  gallery_deleted: boolean;
}

export function createDeletionRepository(
  sql: postgres.Sql,
): DeletionRepository & GuestDraftExpiryRepository {
  return {
    async getMediaForPurge(mediaIds) {
      if (mediaIds.length === 0) return [];
      const ids = pgArray(mediaIds);
      const rows = await sql<MediaRow[]>`
        select m.id, m.gallery_id, m.status, m.original_key,
               m.deleted_at is not null as media_deleted,
               g.deleted_at is not null as gallery_deleted
        from public.media m
        join public.galleries g on g.id = m.gallery_id
        where m.id = any(${ids}::uuid[])`;
      if (rows.length === 0) return [];
      const variants = await sql<{ media_id: string; object_key: string }[]>`
        select media_id, object_key from public.media_variants
        where media_id = any(${ids}::uuid[])`;
      const byMedia = new Map<string, string[]>();
      for (const v of variants) {
        const list = byMedia.get(v.media_id) ?? [];
        list.push(v.object_key);
        byMedia.set(v.media_id, list);
      }
      return rows.map((r) => ({
        id: r.id,
        galleryId: r.gallery_id,
        status: r.status,
        originalKey: r.original_key,
        mediaDeleted: r.media_deleted,
        galleryDeleted: r.gallery_deleted,
        variantKeys: byMedia.get(r.id) ?? [],
      }));
    },

    async markMediaDeleted(mediaIds) {
      if (mediaIds.length === 0) return [];
      const rows = await sql<{ id: string }[]>`
        update public.media m
        set status = 'deleted', deleted_at = coalesce(m.deleted_at, now())
        from public.galleries g
        where m.id = any(${pgArray(mediaIds)}::uuid[])
          and g.id = m.gallery_id
          and m.status <> 'deleted'
          and (m.deleted_at is not null or g.deleted_at is not null)
        returning m.id`;
      return rows.map((r) => r.id);
    },

    async getGalleryDeletion(galleryId) {
      const rows = await sql<{ id: string; deleted: boolean }[]>`
        select id, deleted_at is not null as deleted from public.galleries where id = ${galleryId}`;
      return rows[0] ?? null;
    },

    async listGalleryMediaToPurge(galleryId, afterId, limit) {
      const rows = await sql<{ id: string }[]>`
        select id from public.media
        where gallery_id = ${galleryId}
          and status <> 'deleted'
          and (${afterId}::uuid is null or id > ${afterId}::uuid)
        order by id
        limit ${limit}`;
      return rows.map((r) => r.id);
    },

    async markGalleryArchivesDeleted(galleryId) {
      const rows = await sql`
        update public.archive_jobs
        set status = 'deleted'
        where gallery_id = ${galleryId} and status <> 'deleted'
        returning id`;
      return rows.length;
    },

    async listStuckGalleries(cutoff, limit) {
      const rows = await sql<{ id: string }[]>`
        select g.id from public.galleries g
        where g.deleted_at is not null
          and g.deleted_at < ${cutoff}
          and (
            exists (select 1 from public.media m
                    where m.gallery_id = g.id and m.status <> 'deleted')
            or exists (select 1 from public.archive_jobs a
                       where a.gallery_id = g.id and a.status <> 'deleted')
          )
        order by g.deleted_at, g.id
        limit ${limit}`;
      return rows.map((r) => r.id);
    },

    async listStuckMedia(cutoff, limit) {
      const rows = await sql<{ id: string }[]>`
        select id from public.media
        where status <> 'deleted'
          and deleted_at is not null
          and deleted_at < ${cutoff}
        order by deleted_at, id
        limit ${limit}`;
      return rows.map((r) => r.id);
    },

    async expireGuestDrafts(now, limit) {
      const rows = await sql<{ id: string }[]>`
        with due as (
          select g.id
          from public.galleries g
          join public.guest_sessions gs on gs.id = g.guest_session_id
          where gs.expires_at <= ${now}
            and gs.claimed_at is null
            and gs.claimed_by_user_id is null
            and g.owner_id is null
            and g.claimed_at is null
            and g.status = 'draft'
            and g.deleted_at is null
          order by gs.expires_at, g.id
          limit ${limit}
          for update of g skip locked
        ), gone as (
          update public.galleries g
          set status = 'deleted', deleted_at = ${now}, access_version = g.access_version + 1
          from due
          where g.id = due.id
          returning g.id
        ), uploads as (
          update public.upload_sessions u
          set status = 'expired'
          from gone
          where u.gallery_id = gone.id and u.status = 'pending'
          returning u.id
        ), enqueued as (
          insert into public.job_outbox (event_name, aggregate_id, payload, dedupe_key)
          select 'gallery.delete', gone.id,
                 jsonb_build_object(
                   'type', 'gallery.delete',
                   'galleryId', gone.id,
                   'traceId', 'cron:guest-draft-sweep',
                   'dedupeKey', 'gallery.delete:' || gone.id),
                 'gallery.delete:' || gone.id
          from gone
          on conflict (dedupe_key) do nothing
          returning id
        )
        select id from gone`;
      return rows.map((r) => r.id);
    },
  };
}
