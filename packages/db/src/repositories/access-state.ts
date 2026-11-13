/**
 * SERVER-ONLY. Reads the Postgres fields the media gateway's KV access state is derived from
 * (ADR-001, T20). Used by the worker's `gallery.access_changed` / `gallery.delete` handler and
 * the access-state reconcile sweep. Raw SQL over postgres.js, like the other worker repositories.
 */
import type postgres from 'postgres';
import type { GalleryVisibility } from '@lumra/contracts';
import type { DeliveryPauseReason } from '@lumra/billing';
import type { BillingAccountStatus } from '../enums';

export interface GalleryAccessBilling {
  status: BillingAccountStatus;
  pastDueSince: Date | null;
  restrictedSince: Date | null;
  canceledAt: Date | null;
  /** Delivery safety cutoff in force (Free delivery cap / spending cap), T28/T32. */
  deliveryPausedReason: DeliveryPauseReason | null;
}

export interface GalleryAccessRow {
  id: string;
  status: GalleryVisibility;
  deletedAt: Date | null;
  accessVersion: number;
  expiresAt: Date | null;
  /** Owner's billing account; null for unowned (guest) galleries or owners without one. */
  billing: GalleryAccessBilling | null;
}

export interface AccessStateRepository {
  /** Null when the gallery row no longer exists. */
  getGalleryAccess(galleryId: string): Promise<GalleryAccessRow | null>;
  /**
   * Ids of galleries whose KV state should exist (published or soft-deleted), keyset-paginated
   * by id for the reconcile sweep.
   */
  listSyncableGalleryIds(afterId: string | null, limit: number): Promise<string[]>;
}

interface Row {
  id: string;
  status: GalleryVisibility;
  deleted_at: Date | null;
  access_version: number;
  expires_at: Date | null;
  billing_status: BillingAccountStatus | null;
  past_due_since: Date | null;
  restricted_since: Date | null;
  canceled_at: Date | null;
  delivery_paused_reason: DeliveryPauseReason | null;
}

const toDate = (value: Date | string | null): Date | null =>
  value === null ? null : value instanceof Date ? value : new Date(value);

export function createAccessStateRepository(sql: postgres.Sql): AccessStateRepository {
  return {
    async getGalleryAccess(galleryId) {
      const rows = await sql<Row[]>`
        select g.id, g.status, g.deleted_at, g.access_version, g.expires_at,
               b.status as billing_status, b.past_due_since, b.restricted_since, b.canceled_at,
               b.delivery_paused_reason
        from public.galleries g
        left join public.billing_accounts b on b.user_id = g.owner_id
        where g.id = ${galleryId}`;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        deletedAt: toDate(row.deleted_at),
        accessVersion: Number(row.access_version),
        expiresAt: toDate(row.expires_at),
        billing: row.billing_status
          ? {
              status: row.billing_status,
              pastDueSince: toDate(row.past_due_since),
              restrictedSince: toDate(row.restricted_since),
              canceledAt: toDate(row.canceled_at),
              deliveryPausedReason: row.delivery_paused_reason ?? null,
            }
          : null,
      };
    },

    async listSyncableGalleryIds(afterId, limit) {
      const rows = await sql<{ id: string }[]>`
        select id from public.galleries
        where (status = 'published' or deleted_at is not null or status = 'deleted')
          and (${afterId}::uuid is null or id > ${afterId}::uuid)
        order by id
        limit ${limit}`;
      return rows.map((r) => r.id);
    },
  };
}
