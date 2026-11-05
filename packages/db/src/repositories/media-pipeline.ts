/**
 * SERVER-ONLY. Media derivative pipeline persistence (T12). Raw SQL over postgres.js so the
 * row locks and conditional transitions are explicit; runs in Workers (`nodejs_compat`) through
 * Hyperdrive and in Node against a direct connection.
 */
import type postgres from 'postgres';
import type { AcceptedPhotoMime } from '@lumra/config';
import type { MediaRejectionCode, MediaStatus } from '@lumra/contracts';

export interface MediaForProcessing {
  id: string;
  galleryId: string;
  status: MediaStatus;
  mime: AcceptedPhotoMime;
  byteSize: number;
  originalKey: string;
  /** Client-declared SHA-256 recorded at upload completion (T10), verified by the pipeline. */
  checksumSha256: string | null;
  /** The media or its gallery is soft-deleted (deleted_at set). */
  deleted: boolean;
}

export interface CompletedVariant {
  variant: string;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
}

export interface CompleteProcessingInput {
  mediaId: string;
  /** Authoritative MIME from the sniff + decoder (may correct the client-declared one). */
  mime: AcceptedPhotoMime;
  width: number;
  height: number;
  orientation: number | null;
  takenAt: string | null;
  variants: CompletedVariant[];
}

export type CompleteProcessingResult =
  | { status: 'committed'; staleObjectKeys: string[] }
  /** Nothing was written: the media/gallery was deleted or the row left `processing`. */
  | { status: 'discarded'; reason: 'missing' | 'deleted' | 'not_processing' };

export interface MediaPipelineRepository {
  getForProcessing(mediaId: string): Promise<MediaForProcessing | null>;
  /**
   * `uploaded → processing` (or refreshes `processing` on redelivery, bumping `updated_at` for
   * the stuck-job reconciler). Returns false if the row is deleted or in any other state.
   */
  markProcessing(mediaId: string): Promise<boolean>;
  /**
   * In one transaction: lock the media row (and share-lock its gallery), re-check `deleted_at`
   * and `status = 'processing'`, then upsert `media_variants` and set the media `ready`.
   */
  complete(input: CompleteProcessingInput): Promise<CompleteProcessingResult>;
  /** Marks `failed` with `failure_code` unless the row is deleted or already terminal. */
  markFailed(mediaId: string, code: MediaRejectionCode): Promise<boolean>;
}

interface MediaRow {
  id: string;
  gallery_id: string;
  status: MediaStatus;
  mime: AcceptedPhotoMime;
  byte_size: string | number;
  original_key: string;
  checksum_sha256: string | null;
  deleted: boolean;
}

export function createMediaPipelineRepository(sql: postgres.Sql): MediaPipelineRepository {
  return {
    async getForProcessing(mediaId) {
      const rows = await sql<MediaRow[]>`
        select m.id, m.gallery_id, m.status, m.mime, m.byte_size, m.original_key, m.checksum_sha256,
               (m.deleted_at is not null or g.deleted_at is not null) as deleted
        from public.media m
        join public.galleries g on g.id = m.gallery_id
        where m.id = ${mediaId}`;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        galleryId: row.gallery_id,
        status: row.status,
        mime: row.mime,
        byteSize: Number(row.byte_size),
        originalKey: row.original_key,
        checksumSha256: row.checksum_sha256,
        deleted: row.deleted,
      };
    },

    async markProcessing(mediaId) {
      const rows = await sql`
        update public.media m
        set status = 'processing', failure_code = null
        from public.galleries g
        where m.id = ${mediaId}
          and g.id = m.gallery_id
          and m.status in ('uploaded', 'processing')
          and m.deleted_at is null
          and g.deleted_at is null
        returning m.id`;
      return rows.length === 1;
    },

    async complete(input) {
      return sql.begin(async (tx): Promise<CompleteProcessingResult> => {
        const locked = await tx<{ status: MediaStatus; deleted: boolean }[]>`
          select m.status, (m.deleted_at is not null or g.deleted_at is not null) as deleted
          from public.media m
          join public.galleries g on g.id = m.gallery_id
          where m.id = ${input.mediaId}
          for update of m
          for share of g`;
        const row = locked[0];
        if (!row) return { status: 'discarded', reason: 'missing' };
        if (row.deleted) return { status: 'discarded', reason: 'deleted' };
        if (row.status !== 'processing') return { status: 'discarded', reason: 'not_processing' };

        const existing = await tx<{ object_key: string }[]>`
          select object_key from public.media_variants where media_id = ${input.mediaId}`;
        const keep = new Set(input.variants.map((v) => v.objectKey));
        const staleObjectKeys = existing.map((r) => r.object_key).filter((k) => !keep.has(k));

        await tx`
          delete from public.media_variants
          where media_id = ${input.mediaId}
            and not (variant = any(${input.variants.map((v) => v.variant)}::text[]))`;
        const rows = input.variants.map((v) => ({
          media_id: input.mediaId,
          variant: v.variant,
          object_key: v.objectKey,
          mime: v.mime,
          width: v.width,
          height: v.height,
          byte_size: v.byteSize,
        }));
        await tx`
          insert into public.media_variants
            ${tx(rows, 'media_id', 'variant', 'object_key', 'mime', 'width', 'height', 'byte_size')}
          on conflict (media_id, variant) do update set
            object_key = excluded.object_key,
            mime = excluded.mime,
            width = excluded.width,
            height = excluded.height,
            byte_size = excluded.byte_size,
            ready_at = now()`;
        await tx`
          update public.media_variants set ready_at = now()
          where media_id = ${input.mediaId} and ready_at is null`;
        await tx`
          update public.media set
            status = 'ready',
            ready_at = now(),
            mime = ${input.mime},
            width = ${input.width},
            height = ${input.height},
            orientation = ${input.orientation},
            taken_at = ${input.takenAt},
            failure_code = null
          where id = ${input.mediaId}`;
        return { status: 'committed', staleObjectKeys };
      });
    },

    async markFailed(mediaId, code) {
      const rows = await sql`
        update public.media
        set status = 'failed', failure_code = ${code}
        where id = ${mediaId}
          and status in ('uploaded', 'processing')
          and deleted_at is null
        returning id`;
      return rows.length === 1;
    },
  };
}
