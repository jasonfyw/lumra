import type { GalleryAccessState as GatewayAccessState, GalleryVisibility } from '@lumra/contracts';

/** The Postgres fields the gateway's KV access state is derived from (ADR-001). */
export interface GalleryAccessSource {
  status: GalleryVisibility;
  deletedAt: Date | null;
  accessVersion: number;
  expiresAt: Date | null;
  /** Public delivery blocked for billing reasons (derived by `@lumra/billing`). */
  deliverySuspended: boolean;
}

/**
 * KV document for a gallery, or `null` when nothing should be written:
 * - missing row (hard-deleted) or deleted gallery → tombstone `{deleted: true}` (gateway 404);
 * - draft → `null`: drafts were never servable and a missing document already fails closed;
 * - published → current version, expiry (the gateway computes "expired" itself) and suspension.
 */
export function galleryAccessSnapshot(
  gallery: GalleryAccessSource | null,
  now: Date,
): GatewayAccessState | null {
  const updatedAt = now.toISOString();
  if (!gallery || gallery.status === 'deleted' || gallery.deletedAt !== null) {
    return {
      accessVersion: gallery?.accessVersion ?? 0,
      deleted: true,
      expiresAt: null,
      deliverySuspended: true,
      updatedAt,
    };
  }
  if (gallery.status !== 'published') return null;
  return {
    accessVersion: gallery.accessVersion,
    deleted: false,
    expiresAt: gallery.expiresAt ? gallery.expiresAt.toISOString() : null,
    deliverySuspended: gallery.deliverySuspended,
    updatedAt,
  };
}
